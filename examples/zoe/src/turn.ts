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
 * don't declare any), the failure surfaces as an `error.escaped` event on the
 * `onEvent` stream. The actor is stopped and `runTurn` resolves with
 * `{ ok: false }` so the host can branch.
 *
 * Observability is the unified `onEvent` stream (spec 013): one callback yields
 * the whole lifecycle. `correlationId` carries `sessionId` onto every event, so
 * logs trace back to the conversation without manual threading.
 *
 * @param text       The user's message.
 * @param snapshot   Snapshot captured by the previous `runTurn`, if any.
 * @param sessionId  Host-side session identifier — passed as `correlationId`
 *                   so every emitted event (and every log line) is tagged with
 *                   the originating conversation.
 */
export async function runTurn(
    text: string,
    snapshot: AgentSnapshot<AgentContext> | undefined,
    sessionId: string,
): Promise<TurnResult> {
    // Readiness gate is host-implemented from the `onEvent` stream. The host
    // knows the agent consumes the next user event once it parks (here, back in
    // `"listening"`); Atlas surfaces that as a `mode.parked` event.
    let resolveReady: (() => void) | null = null;
    const unblock = (): void => {
        if (resolveReady !== null) {
            const r = resolveReady;
            resolveReady = null;
            r();
        }
    };
    // Reference cell — closure writes are invisible to TS control-flow
    // analysis, so a plain `let escape: ... | null` would narrow to `null`
    // after init and read as `never` post-await.
    const escapeRef: { current: { modePath: string; error: unknown } | null } = {
        current: null,
    };

    const actor = startAgent<AgentContext, AgentEvents>(agentMachine, {
        snapshot,
        // SPEC 013: one stream, tagged with the session id, drives both logging
        // and the readiness/escape control flow.
        correlationId: sessionId,
        onEvent: (e) => {
            switch (e.kind) {
                case "mode.entered":
                    console.log(`[#${e.seq} ${e.correlationId}] → ${e.modePath}`);
                    break;
                case "mode.run.settled":
                    // Outcome + latency per mode — the resilience/timing signal
                    // the old `transition`-only stream could not express.
                    console.log(
                        `[#${e.seq}] ${e.modePath} ${e.outcome} (${e.durationMs}ms)`,
                    );
                    break;
                case "mode.parked":
                    // Readiness: the agent parked waiting for the next message.
                    unblock();
                    break;
                case "error.escaped": {
                    // Fire-and-log: a rejection inside an active mode's
                    // `behavior` (chat() network errors, JSON parse failures)
                    // that no `routes.error` caught. Capture the frame, unblock
                    // the gate, and let the host branch on `TurnResult`.
                    const message = e.error instanceof Error ? e.error.message : String(e.error);
                    console.error(
                        `[escape] session=${e.correlationId} mode=${e.modePath} error=${message}`,
                    );
                    escapeRef.current = { modePath: e.modePath, error: e.error };
                    unblock();
                    break;
                }
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
