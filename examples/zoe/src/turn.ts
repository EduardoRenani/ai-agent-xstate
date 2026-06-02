// One `runTurn` call per incoming message. The API-shaped use case: in
// production the host is typically an HTTP endpoint or a message-queue
// consumer that looks up a session, runs one turn, persists the new state,
// and returns.

import { startAgent, type AgentSnapshot } from "@eduardorenani/atlasjs";

import { agentMachine } from "./machine.js";
import type { AgentContext, AgentEvents } from "./types.js";

/**
 * Run a single conversational turn against `agentMachine`.
 *
 * Each call boots a fresh actor from `snapshot` (or from `initial` when
 * `snapshot` is omitted), sends `MESSAGE`, awaits the agent's return to
 * `listening`, captures the new snapshot, and stops the actor. The returned
 * snapshot feeds back into the next call — that thread is the multi-turn
 * state.
 *
 * @param text      The user's message.
 * @param snapshot  Snapshot captured by the previous `runTurn`, if any.
 * @returns         The snapshot to persist for the next turn.
 */
export async function runTurn(
    text: string,
    snapshot?: AgentSnapshot<AgentContext>,
): Promise<AgentSnapshot<AgentContext>> {
    // Readiness gate is host-implemented from the `inspect` primitive. The
    // host knows which leaf consumes the next user event (here, `"listening"`);
    // Atlas does not infer it.
    let resolveReady: (() => void) | null = null;

    const actor = startAgent<AgentContext, AgentEvents>(agentMachine, {
        snapshot,
        inspect: (e) => {
            console.log(`[transition] ${e.from} → ${e.to}`);
            if (e.to === "listening" && resolveReady !== null) {
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

    const next = actor.getSnapshot();
    actor.stop();
    return next;
}
