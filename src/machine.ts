import { setup, assign, enqueueActions } from "xstate";
import type { Message } from "./openrouter.js";
import { greetingsNode } from "./states/greetings.state.js";
import { improviseThinkingNode } from "./states/improvise.thinking.state.js";

// ── Machine ──────────────────────────────────────────────────────────

export const agentMachine = setup({
    types: {
        context: {} as {
            messages: Message[];
        },
        events: {} as
            | { type: "MESSAGE"; text: string }
            | { type: "PARTIALLY_RESPONDED" },
    },
    actions: {
        appendUserMessage: assign({
            messages: ({ context, event }) => [
                ...context.messages,
                // Safe: this action is only referenced from MESSAGE transitions.
                { role: "user" as const, content: (event as { type: "MESSAGE"; text: string }).text },
            ],
        }),
    },
    actors: { greetingsNode, improviseThinkingNode },
}).createMachine({
    id: "agent",
    initial: "idle",
    context: {
        messages: [],
    },

    states: {
        idle: {
            on: {
                MESSAGE: {
                    target: "greetings",
                    actions: "appendUserMessage",
                },
            },
        },

        greetings: {
            invoke: {
                src: "greetingsNode",
                input: ({ context }) => ({
                    messages: context.messages,
                }),
                onDone: {
                    target: "improvise",
                    actions: enqueueActions(({ enqueue, event }) => {
                        const { greeting, needsFollowUp } = (event as { output: { greeting: string; needsFollowUp: boolean } }).output;
                        console.log(`\n${greeting}\n`);
                        enqueue.assign({
                            messages: ({ context }) => [
                                ...context.messages,
                                { role: "assistant" as const, content: greeting },
                            ],
                        });
                        if (needsFollowUp) {
                            enqueue.raise({ type: "PARTIALLY_RESPONDED" });
                        }
                    }),
                },
                onError: {
                    target: "improvise",
                    actions: ({ event }: { event: { error: unknown } }) => {
                        console.error(
                            "\nError generating greeting:",
                            (event.error as Error).message,
                            "\n"
                        );
                    },
                },
            },
        },

        improvise: {
            initial: "listening",
            states: {
                listening: {
                    on: {
                        PARTIALLY_RESPONDED: {
                            target: "thinking",
                        },
                        MESSAGE: {
                            target: "thinking",
                            actions: "appendUserMessage",
                        },
                    },
                },
                thinking: {
                    invoke: {
                        src: "improviseThinkingNode",
                        input: ({ context }) => ({
                            messages: context.messages,
                        }),
                        onDone: {
                            target: "listening",
                            actions: [
                                ({ event }) => {
                                    const newMessages = event.output as Message[];
                                    const lastMessage = newMessages[newMessages.length - 1];
                                    if (lastMessage && lastMessage.role === "assistant" && lastMessage.content !== null) {
                                        console.log(`\n${lastMessage.content}\n`);
                                    }
                                },
                                assign({
                                    messages: ({ context, event }) => [
                                        ...context.messages,
                                        ...(event.output as Message[]),
                                    ],
                                }),
                            ],
                        },
                        onError: {
                            target: "listening",
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
            },
        },
    },
});
