import { setup, assign, createActor } from "xstate";
import type { Message } from "./llm-client.js";
import type { ModeOutput } from "./types.js";
import { classifyingMode } from "./states/classifying.mode.js";
import { greetingsThinkingMode } from "./states/greetings.thinking.mode.js";
import { socraticTeachingMode } from "./states/socratic.teaching.mode.js";
import { socraticEvaluatingMode } from "./states/socratic.evaluating.mode.js";
import { improvisingThinkingMode } from "./states/improvising.thinking.mode.js";

// ── Machine ──────────────────────────────────────────────────────────

export const agentMachine = setup({
    types: {
        context: {} as {
            messages: Message[];
        },
        events: {} as { type: "MESSAGE"; text: string },
    },
    actions: {
        appendUserMessage: assign({
            messages: ({ context, event }) => [
                ...context.messages,
                { role: "user" as const, content: (event as { type: "MESSAGE"; text: string }).text },
            ],
        }),
    },
    actors: {
        classifyingMode,
        greetingsThinkingMode,
        socraticTeachingMode,
        socraticEvaluatingMode,
        improvisingThinkingMode,
    },
}).createMachine({
    id: "agent",
    initial: "listening",
    context: {
        messages: [],
    },

    states: {
        listening: {
            on: {
                MESSAGE: {
                    target: "classifying",
                    actions: "appendUserMessage",
                },
            },
        },

        classifying: {
            invoke: {
                src: "classifyingMode",
                input: ({ context }) => ({
                    messages: context.messages,
                }),
                onDone: [
                    {
                        guard: ({ event }) => event.output.payload.intent === "greetings",
                        target: "greetings",
                    },
                    {
                        guard: ({ event }) => event.output.payload.intent === "socratic",
                        target: "socratic",
                    },
                    {
                        guard: ({ event }) => event.output.payload.intent === "none",
                        target: "listening",
                    },
                    {
                        target: "improvising",
                    },
                ],
            },
        },

        greetings: {
            initial: "thinking",
            states: {
                thinking: {
                    invoke: {
                        src: "greetingsThinkingMode",
                        input: ({ context }) => ({
                            messages: context.messages,
                        }),
                        onDone: {
                            target: "done",
                            actions: assign({
                                messages: ({ context, event }) => [
                                    ...context.messages,
                                    ...(event.output as ModeOutput<{ messages: Message[] }>).payload.messages,
                                ],
                            }),
                        },
                    },
                },
                done: { type: "final" },
            },
            onDone: { target: "classifying" },
        },

        socratic: {
            initial: "teaching",
            states: {
                teaching: {
                    invoke: {
                        src: "socraticTeachingMode",
                        input: ({ context }) => ({
                            messages: context.messages,
                        }),
                        onDone: {
                            target: "listening",
                            actions: assign({
                                messages: ({ context, event }) => [
                                    ...context.messages,
                                    ...(event.output as ModeOutput<{ messages: Message[] }>).payload.messages,
                                ],
                            }),
                        },
                    },
                },
                listening: {
                    on: {
                        MESSAGE: {
                            target: "evaluating",
                            actions: "appendUserMessage",
                        },
                    },
                },
                evaluating: {
                    invoke: {
                        src: "socraticEvaluatingMode",
                        input: ({ context }) => ({
                            messages: context.messages,
                        }),
                        onDone: [
                            {
                                guard: ({ event }) => event.output.outcome === "achieved",
                                target: "done",
                            },
                            {
                                guard: ({ event }) => event.output.outcome === "abandoned",
                                target: "done",
                            },
                            {
                                target: "teaching",
                            },
                        ],
                    },
                },
                done: { type: "final" },
            },
            onDone: { target: "classifying" },
        },

        improvising: {
            initial: "thinking",
            states: {
                thinking: {
                    invoke: {
                        src: "improvisingThinkingMode",
                        input: ({ context }) => ({
                            messages: context.messages,
                        }),
                        onDone: {
                            target: "done",
                            actions: assign({
                                messages: ({ context, event }) => [
                                    ...context.messages,
                                    ...(event.output as ModeOutput<{ messages: Message[] }>).payload.messages,
                                ],
                            }),
                        },
                        onError: {
                            target: "done",
                            actions: ({ event }) => {
                                console.error(
                                    "\nError calling LLM:",
                                    (event.error as Error).message,
                                    "\n"
                                );
                            },
                        },
                    },
                },
                done: { type: "final" },
            },
            onDone: { target: "classifying" },
        },
    },
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
                (evt.snapshot as { value: unknown }).value,
            );
            if (previousState !== newState) {
                console.log(`[transition] ${previousState} → ${newState} (${evt.event.type})`);
                previousState = newState;
            }
        },
    });

    return actor;
}
