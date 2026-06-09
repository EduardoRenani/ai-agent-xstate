// `startAgent` — boot an Atlas agent.
//
// Spec: docs/specs/009-snapshot-aware-rehydration.md
//        §`startAgent` + §Persistence Contract + §Mapping
//       docs/specs/010-error-channel.md
//        §Public API Changes + §Behavior Contract + §Mapping
//
// Wraps XState's `createActor(...).start()` so:
//   1. A persisted `AgentSnapshot` survives compound-`local` reset on entry
//      (spec 009 / issue #15).
//   2. Hosts no longer import from `xstate` directly (spec 009 / issue #12).
//   3. Rejections that escape the machine's declarative recovery
//      (`routes.error`) surface to a typed host callback via
//      `options.onError`, instead of becoming uncaught process-level errors
//      (spec 010 / P14).
//
// This file is the ONLY place inside `packages/atlas/src` allowed to import
// `createActor`. The wrapper hides it; nothing else in user code or in the
// examples references XState's runtime API.

import { createActor, type AnyStateMachine, type InspectionEvent, type Snapshot } from "xstate";

import { formatModePath } from "./formatModePath.ts";
import type {
    AgentActor,
    AgentSnapshot,
    StartAgentOptions,
} from "./types.ts";

const ATLAS_SNAPSHOT_VERSION = "1";

/**
 * Boot an Atlas agent. Wraps `createActor(...).start()` under the hood.
 *
 * - When `options.snapshot` is provided, the actor is rehydrated from that
 *   snapshot. XState v5 does NOT re-run `entry` actions on a restored state,
 *   so compound-`local` slots in the snapshot survive (spec 009
 *   §Persistence Contract).
 * - When `options.inspect` is provided, it receives Atlas-vocabulary
 *   events. Phase 1 emits only `transition`.
 *
 * The returned `AgentActor` is auto-started. Call `.stop()` to dispose.
 *
 * @template TContext  The agent's root context shape. Must match the shape
 *                     the machine was declared with — `AgentSnapshot<TContext>`
 *                     refuses cross-context restores at the type level.
 * @template TEvents   The agent's full event union. Used to type `send`.
 */
export function startAgent<TContext, TEvents extends { type: string }>(
    agent: AnyStateMachine,
    options?: StartAgentOptions<TContext>,
): AgentActor<TContext, TEvents> {
    let previousPath: string | undefined;
    // SPEC 011 Clarification #6: dedup must also track readiness. Masking
    // collapses `foo.$run` and `foo.$wait` to the same `"foo"`, so a within-mode
    // `$run → $wait` (or `$wait → $run`) transition would otherwise be deduped
    // away by the path comparison — swallowing the readiness signal the host
    // needs. Track "was parked" alongside the path so a running↔parked flip in
    // the same masked mode still emits.
    let previouslyParked = false;
    const userInspect = options?.inspect;
    const userOnError = options?.onError;

    const xstateActor = createActor(agent, {
        snapshot: options?.snapshot?.persisted as Snapshot<unknown> | undefined,
        inspect: userInspect
            ? (raw: InspectionEvent) => {
                if (raw.type !== "@xstate.snapshot") return;
                // Filter foreign actors. The closure captures `xstateActor`
                // by reference; sound even though the variable is referenced
                // inside its own initializer — the inspect callback fires
                // only on subsequent updates.
                if (raw.actorRef !== xstateActor) return;
                const snap = raw.snapshot as unknown as {
                    value: unknown;
                    context: TContext;
                    // SPEC 011 Clarification #6: XState v5's `getMeta()` returns a
                    // record keyed by each ACTIVE state-node id → that node's
                    // `meta`. A parked mode's active leaf is its `$wait`, so the
                    // `atlasAwaiting` we stamped in `buildWaitState` surfaces here.
                    getMeta: () => Record<string, unknown>;
                };
                const next = formatModePath(snap.value);
                // SPEC 011 Clarification #6: readiness is reported explicitly via
                // `awaiting` (the path is now masked, so "parked vs running" can no
                // longer be inferred from it). Scan the active states' meta for
                // `atlasAwaiting`; when found, the agent is parked in a `$wait`.
                const awaiting = readAwaiting(snap.getMeta());
                const parked = awaiting !== undefined;
                // Emit when EITHER the masked path or the parked/running state
                // changed — so a within-mode `$run ↔ $wait` flip is not deduped.
                if (next === previousPath && parked === previouslyParked) return;
                const from = previousPath ?? "(init)";
                previousPath = next;
                previouslyParked = parked;
                userInspect({
                    type: "transition",
                    from,
                    to: next,
                    context: snap.context,
                    ...(awaiting !== undefined ? { awaiting } : {}),
                });
            }
            : undefined,
    });

    // Spec 010 §Behavior Contract: subscribe ONLY when `onError` is provided.
    // When omitted, no subscribe call is made — XState's default propagation
    // is preserved (the strict additive guarantee).
    if (userOnError !== undefined) {
        xstateActor.subscribe({
            error: (rawError: unknown) => {
                // Spec 010 §Snapshot-at-error semantics: read the actor's
                // current snapshot synchronously inside the error subscriber.
                // xstate@5.31.1 keeps `value` and `context` populated at this
                // point (the failed leaf is still in `value`).
                const live = xstateActor.getSnapshot() as unknown as {
                    value: unknown;
                    context: TContext;
                };
                userOnError({
                    error: rawError,
                    modePath: formatModePath(live.value),
                    context: live.context,
                    snapshot: buildAgentSnapshot<TContext>(
                        xstateActor.getPersistedSnapshot(),
                    ),
                });
            },
        });
    }

    xstateActor.start();

    return {
        send: (event: TEvents) => {
            xstateActor.send(event);
        },
        stop: () => {
            xstateActor.stop();
        },
        getSnapshot: () => buildAgentSnapshot<TContext>(xstateActor.getPersistedSnapshot()),
    };
}

// SPEC 011 Clarification #6: recover the parked mode's waited-on event types
// from the active states' `meta`. `getMeta()` returns `{ [stateNodeId]: meta }`
// for every active state; a parked mode's `$wait` leaf carries
// `meta.atlasAwaiting`. Returns the event-type list when found (so `awaiting`
// is present and non-empty), else `undefined` (the agent is running in `$run`).
function readAwaiting(metaByNode: Record<string, unknown>): readonly string[] | undefined {
    for (const meta of Object.values(metaByNode)) {
        if (typeof meta !== "object" || meta === null) continue;
        const awaiting = (meta as { atlasAwaiting?: unknown }).atlasAwaiting;
        if (Array.isArray(awaiting) && awaiting.length > 0) {
            return awaiting as readonly string[];
        }
    }
    return undefined;
}

function buildAgentSnapshot<TContext>(persisted: Snapshot<unknown>): AgentSnapshot<TContext> {
    return {
        atlasVersion: ATLAS_SNAPSHOT_VERSION,
        persisted,
    } as AgentSnapshot<TContext>;
}
