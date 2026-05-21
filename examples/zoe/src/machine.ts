import { createActor } from "xstate";

import { defineAgent } from "atlas";

import { classifying } from "./states/classifying.js";
import { greetings } from "./states/greetings.js";
import { improvising } from "./states/improvising.js";
import { listening } from "./states/listening.js";
import { socratic } from "./states/socratic.js";
import type { AgentContext, AgentEvents } from "./types.js";

// ── Machine ──────────────────────────────────────────────────────────

export const agentMachine = defineAgent<
    AgentContext,
    AgentEvents,
    {
        listening: typeof listening;
        classifying: typeof classifying;
        greetings: typeof greetings;
        socratic: typeof socratic;
        improvising: typeof improvising;
    }
>({
    id: "agent",
    initial: "listening",
    context: { messages: [] },
    events: {} as AgentEvents,
    actions: {
        appendUserMessage: ({ context, event }) => ({
            messages: [
                ...context.messages,
                { role: "user" as const, content: event.text },
            ],
        }),
    },
    states: { listening, classifying, greetings, socratic, improvising },
});

// ── Factory ──────────────────────────────────────────────────────────

function formatStateValue(value: unknown): string {
    if (typeof value === "string") return value;
    if (typeof value === "object" && value !== null) {
        return Object.entries(value as Record<string, unknown>)
            .map(([k, v]) => `${k}.${formatStateValue(v)}`)
            .join(", ");
    }
    return String(value);
}

export function createAgentActor() {
    let previousState = "(init)";

    const actor = createActor(agentMachine, {
        inspect: (evt) => {
            if (evt.type !== "@xstate.snapshot") return;
            if (evt.actorRef !== actor) return;

            const newState = formatStateValue(
                (evt.snapshot as unknown as { value: unknown }).value,
            );
            if (previousState !== newState) {
                console.log(`[transition] ${previousState} → ${newState}`);
                previousState = newState;
            }
        },
    });

    return actor;
}
