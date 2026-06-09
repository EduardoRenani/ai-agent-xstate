// One `runTurn` call per incoming message. The API-shaped use case: in
// production the host is typically an HTTP endpoint or a message-queue
// consumer that looks up a session, runs one turn, persists the new state,
// and returns.

import { startAgent, type AgentSnapshot } from "@eduardorenani/atlasjs";

import { agentMachine } from "./machine.js";
import type { AgentContext, AgentEvents } from "./types.js";

/**
 * Outcome of a single turn. `ok: true` carries the new snapshot to persist;
 * `ok: false` carries the failed leaf path and the raw rejection. The host
 * decides what to do — Zoe's `index.ts` logs and keeps the previous snapshot
 * so the next message restarts from the last-good `listening`.
 */
export type TurnResult =
    | { ok: true; snapshot: AgentSnapshot<AgentContext> }
    | { ok: false; modePath: string; error: unknown };

/**
 * Run a single conversational turn against `agentMachine`.
 *
 * Each call boots a fresh actor from `snapshot` (or from `initial` when
 * `snapshot` is omitted), sends `MESSAGE`, awaits the agent's return to
 * `listening`, captures the new snapshot, and stops the actor. The returned
 * snapshot feeds back into the next call — that thread is the multi-turn
 * state.
 *
 * When a `behavior` rejects and no `routes.error` catches it (Zoe's modes
 * don't declare any), the failure surfaces through `onError`. The actor is
 * stopped and `runTurn` resolves with `{ ok: false }` so the host can branch.
 *
 * @param text       The user's message.
 * @param snapshot   Snapshot captured by the previous `runTurn`, if any.
 * @param sessionId  Host-side session identifier — included in escape logs
 *                   so multi-tenant deployments can trace failures back to
 *                   the originating conversation.
 */
export async function runTurn(
    text: string,
    snapshot: AgentSnapshot<AgentContext> | undefined,
    sessionId: string,
): Promise<TurnResult> {
    // Readiness gate is host-implemented from the `inspect` primitive. The
    // host knows which leaf consumes the next user event (here, `"listening"`);
    // Atlas does not infer it.
    let resolveReady: (() => void) | null = null;
    // Reference cell — closure writes are invisible to TS control-flow
    // analysis, so a plain `let escape: ... | null` would narrow to `null`
    // after init and read as `never` post-await.
    const escapeRef: { current: { modePath: string; error: unknown } | null } = {
        current: null,
    };

    const actor = startAgent<AgentContext, AgentEvents>(agentMachine, {
        snapshot,
        inspect: (e) => {
            console.log(`[transition] ${e.from} → ${e.to}`);
            // SPEC 011 Clarification #6: readiness is "the agent has parked
            // waiting for input", surfaced as a non-empty `awaiting` (the event
            // types that will resume it) — not a path match. The synthetic
            // `$wait` substate is masked from `e.to`, so we read readiness from
            // `awaiting` instead of checking `e.to === "listening"` / `.$wait`.
            const parked = e.awaiting !== undefined && e.awaiting.length > 0;
            if (parked && resolveReady !== null) {
                const r = resolveReady;
                resolveReady = null;
                r();
            }
        },
        // Fire-and-log: a rejection inside any active mode's `behavior`
        // (chat() network errors, JSON parse failures, etc.) surfaces here
        // with the failed leaf path and the live root context. We capture
        // the frame, unblock the readiness gate, and let the host branch on
        // the returned `TurnResult`.
        onError: (info) => {
            escapeRef.current = { modePath: info.modePath, error: info.error };
            const message = info.error instanceof Error
                ? info.error.message
                : String(info.error);
            console.error(
                `[escape] session=${sessionId} mode=${info.modePath} error=${message}`,
            );
            if (resolveReady !== null) {
                const r = resolveReady;
                resolveReady = null;
                r();
            }
        },
    });

    const ready = new Promise<void>((r) => {
        resolveReady = r;
    });

    actor.send({ type: "MESSAGE", text });
    await ready;

    const escape = escapeRef.current;
    if (escape !== null) {
        actor.stop();
        return { ok: false, modePath: escape.modePath, error: escape.error };
    }

    const next = actor.getSnapshot();
    actor.stop();
    return { ok: true, snapshot: next };
}
