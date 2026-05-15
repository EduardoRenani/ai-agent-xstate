import { setup, assign, createActor } from "xstate";
import type { Message } from "./llm-client.js";
import type { ModeGoalEvaluation } from "./types.js";
import { classifyingNode } from "./states/classifying.state.js";
import { greetingsThinkingNode } from "./states/greetings.thinking.state.js";
import { socraticTeachingNode } from "./states/socratic.teaching.state.js";
import { socraticEvaluatingNode } from "./states/socratic.evaluating.state.js";
import { improvisingThinkingNode } from "./states/improvising.thinking.state.js";

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
        classifyingNode,
        greetingsThinkingNode,
        socraticTeachingNode,
        socraticEvaluatingNode,
        improvisingThinkingNode,
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
                src: "classifyingNode",
                input: ({ context }) => ({
                    messages: context.messages,
                }),
                onDone: [ // no fim do bloco de execucao
                    {   // roda a funcao de transicao com o output do bloco de execucao
                        guard: ({ event }) => event.output.intent === "greetings",
                        target: "greetings",
                    },
                    {
                        guard: ({ event }) => event.output.intent === "socratic",
                        target: "socratic",
                    },
                    {
                        guard: ({ event }) => event.output.intent === "none",
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
                        src: "greetingsThinkingNode",
                        input: ({ context }) => ({
                            messages: context.messages,
                        }),
                        onDone: {
                            target: "done",
                            actions: assign({
                                messages: ({ context, event }) => [
                                    ...context.messages,
                                    ...(event.output as Message[]),
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
                        src: "socraticTeachingNode",
                        input: ({ context }) => ({
                            messages: context.messages,
                        }),
                        onDone: {
                            target: "listening",
                            actions: assign({
                                messages: ({ context, event }) => [
                                    ...context.messages,
                                    ...(event.output as Message[]),
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
                        src: "socraticEvaluatingNode",
                        input: ({ context }) => ({
                            messages: context.messages,
                        }),
                        onDone: [
                            {
                                guard: ({ event }) => event.output.evaluation === "achieved",
                                target: "done",
                                actions: assign({
                                    messages: ({ context, event }) => [
                                        ...context.messages,
                                        ...(event.output as { evaluation: ModeGoalEvaluation; messages: Message[] }).messages,
                                    ],
                                }),
                            },
                            {
                                guard: ({ event }) => event.output.evaluation === "abandoned",
                                target: "done",
                                actions: assign({
                                    messages: ({ context, event }) => [
                                        ...context.messages,
                                        ...(event.output as { evaluation: ModeGoalEvaluation; messages: Message[] }).messages,
                                    ],
                                }),
                            },
                            {
                                target: "teaching",
                                actions: assign({
                                    messages: ({ context, event }) => [
                                        ...context.messages,
                                        ...(event.output as { evaluation: ModeGoalEvaluation; messages: Message[] }).messages,
                                    ],
                                }),
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
                        src: "improvisingThinkingNode",
                        input: ({ context }) => ({
                            messages: context.messages,
                        }),
                        onDone: {
                            target: "done",
                            actions: assign({
                                messages: ({ context, event }) => [
                                    ...context.messages,
                                    ...(event.output as Message[]),
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
