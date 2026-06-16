// `startAgent` — boot an Atlas agent.
//
// Spec: docs/specs/009-snapshot-aware-rehydration.md
//        §`startAgent` + §Persistence Contract + §Mapping
//       docs/specs/010-error-channel.md
//        §Public API Changes + §Behavior Contract + §Mapping
//       docs/specs/012-xstate-containment.md
//        §Seam 2 (Atlas-owned persisted payload, atlasVersion "2")
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
// SPEC 012 §Seam 3 (P22): the `meta.atlasAwaiting` channel is owned by
// `xstateBackend` (it stamps the key in `buildWaitState`). We read it back here
// through the shared constant instead of a local magic string so the channel
// has a single source of truth. `startAgent` already imports xstate, so this
// import crosses no boundary (boundary.test.ts stays green).
import { ATLAS_AWAITING_META_KEY } from "./xstateBackend.ts";
import type {
    Agent,
    AgentActor,
    AgentSnapshot,
    JsonValue,
    PersistedAgentSnapshot,
    StartAgentOptions,
} from "./types.ts";

// SPEC 012 §Seam 2 (DD-032): Atlas owns the persisted schema. `atlasVersion` is
// the dispatch key — bump it whenever the payload shape changes. v2 is the
// carrier-neutral `{ value, context }` descriptor; v1 was XState's raw blob.
const ATLAS_SNAPSHOT_VERSION = "2";

// The concrete shape behind the opaque `PersistedAgentSnapshot` brand. Internal
// to this file; consumers only ever see the brand.
type PersistedV2 = {
    readonly atlasVersion: "2";
    // Carrier-neutral active-configuration descriptor (today: XState's state
    // value object, e.g. `{ socratic: { teaching: "$wait" } }`).
    readonly value: JsonValue;
    // Root context, synthetic compound-local / `$event` slots included.
    readonly context: JsonValue;
};

/**
 * Boot an Atlas agent. Wraps `createActor(...).start()` under the hood.
 *
 * - When `options.snapshot` is provided, the actor is rehydrated from the
 *   Atlas-owned v2 payload (spec 012 §Seam 2): `startAgent` synthesizes the
 *   carrier snapshot from `{ value, context }`. XState v5 does NOT re-run
 *   `entry` actions on a restored state, so compound-`local` slots survive
 *   (spec 009 §Persistence Contract). Snapshots stamped with an older
 *   `atlasVersion` hit the mismatch path — soft reset to `initial`
 *   (Clarification C2).
 * - When `options.inspect` is provided, it receives Atlas-vocabulary
 *   events. Phase 1 emits only `transition`.
 *
 * The returned `AgentActor` is auto-started. Call `.stop()` to dispose.
 *
 * SPEC 012 §Seam 1: both generics are **inferred from the `Agent` brand** —
 * `startAgent(agent)` needs no type arguments. The explicit
 * `startAgent<Ctx, Ev>(agent)` form still compiles but is now cross-checked
 * against the brand, so `options.snapshot` (typed `AgentSnapshot<TContext>`)
 * is anchored to the agent's own context, not to whatever the caller typed.
 *
 * @template TContext  The agent's root context shape, inferred from `agent`.
 * @template TEvents   The agent's full event union, inferred from `agent`.
 *                     Used to type `send`.
 */
export function startAgent<TContext, TEvents extends { type: string }>(
    agent: Agent<TContext, TEvents>,
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

    // SPEC 012 §Seam 1: unwrap the opaque carrier with a single localized cast
    // — the consume-side counterpart to the wrap in `defineAgent`. This is the
    // only place below the seam that hands the carrier to the engine.
    const carrier = agent.carrier as AnyStateMachine;

    const xstateActor = createActor(carrier, {
        // SPEC 012 §Seam 2: resolve the restore snapshot from the Atlas v2
        // payload, dispatching on `atlasVersion`. Older versions → undefined →
        // fresh boot into `initial` (the mismatch path, Clarification C2).
        snapshot: resolveRestore(options?.snapshot),
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
        const awaiting = (meta as { [ATLAS_AWAITING_META_KEY]?: unknown })[ATLAS_AWAITING_META_KEY];
        if (Array.isArray(awaiting) && awaiting.length > 0) {
            return awaiting as readonly string[];
        }
    }
    return undefined;
}

// SPEC 012 §Seam 2 (Save): derive the Atlas-owned `{ value, context }` payload
// from the carrier's persisted snapshot. We drop `children`/`status` and the
// other carrier internals Atlas neither needs nor wants to own — the survival
// contract (spec 009) is exactly active mode path + root context, and compound
// locals + the `$event` slot already live in context.
function buildAgentSnapshot<TContext>(carrierSnapshot: Snapshot<unknown>): AgentSnapshot<TContext> {
    const { value, context } = carrierSnapshot as unknown as {
        value: JsonValue;
        context: JsonValue;
    };
    const payload: PersistedV2 = { atlasVersion: ATLAS_SNAPSHOT_VERSION, value, context };
    return {
        atlasVersion: ATLAS_SNAPSHOT_VERSION,
        persisted: payload as unknown as PersistedAgentSnapshot,
    } as AgentSnapshot<TContext>;
}

// SPEC 012 §Seam 2 (Restore): resolve what to feed XState's `createActor`.
// Dispatch on `atlasVersion`: only the current v2 payload restores; anything
// older returns `undefined`, so the actor boots fresh into `initial` — the
// mismatch path (Clarification C2; alpha makes no cross-version promises).
function resolveRestore<TContext>(
    snapshot: AgentSnapshot<TContext> | undefined,
): Snapshot<unknown> | undefined {
    if (snapshot === undefined) return undefined;
    if (snapshot.atlasVersion !== ATLAS_SNAPSHOT_VERSION) return undefined;
    return synthesizeCarrierSnapshot(snapshot.persisted as unknown as PersistedV2);
}

// SPEC 012 §Seam 2 (Restore): rebuild the minimal carrier snapshot the engine
// needs from the Atlas payload. `{ status: "active", children: {} }` is the
// shape XState v5's `restoreSnapshot` accepts; with `value`/`context` present
// it restores the active configuration without re-running `entry` actions.
// Mid-`$run` snapshots are out of scope (Clarification C9 / spec 009's
// turn-based model: persist while parked), so active invokes are not
// reconstructed — a restored `$wait` (the between-turns case) carries no
// children anyway.
function synthesizeCarrierSnapshot(payload: PersistedV2): Snapshot<unknown> {
    return {
        status: "active",
        value: payload.value,
        context: payload.context,
        children: {},
    } as unknown as Snapshot<unknown>;
}
