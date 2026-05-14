import { setup, assign, fromPromise, raise } from "xstate";
import { chat } from "./openrouter.js";

const GREETINGS_SYSTEM_PROMPT = [
    "Você é Atlas, um assistente de propósito geral.",
    "Cumprimente o usuário em português do Brasil de forma amigável e direta.",
    "Apresente-se brevemente pelo nome.",
    "Não responda perguntas — apenas cumprimente.",
    "Mantenha a saudação curta (1-2 frases).",
].join(" ");

const IMPROVISE_SYSTEM_PROMPT = [
    "Você é Atlas, um assistente de propósito geral.",
    "Seu tom é amigável e direto.",
    "Responda sempre em português do Brasil.",
    "Responda às perguntas do usuário de forma útil e concisa.",
].join(" ");

export const agentMachine = setup({
    // types: declares the TypeScript types for context (shared data) and events
    // (messages the machine can receive). This gives type safety across the machine.
    types: {
        context: {} as {
            messages: Array<{ role: "user" | "assistant"; content: string }>;
        },
        events: {} as
            | { type: "MESSAGE"; text: string }
            | { type: "PARTIALLY_RESPONDED" },
    },

    // actions: named reusable actions referenced by string in the machine definition.
    actions: {
        appendUserMessage: assign({
            messages: ({ context, event }) => [
                ...context.messages,
                // Safe: this action is only referenced from MESSAGE transitions.
                { role: "user" as const, content: (event as { type: "MESSAGE"; text: string }).text },
            ],
        }),
    },

    // actors: named async services the machine can invoke.
    // fromPromise wraps an async function into an actor that XState can manage —
    // starting it when a state is entered and collecting the result via onDone/onError.
    actors: {
        callLLM: fromPromise(
            async ({ input }: {
                input: {
                    messages: Array<{ role: "user" | "assistant"; content: string }>;
                    systemPrompt: string;
                };
            }) => {
                return chat(input.messages, input.systemPrompt);
            }
        ),
    },
}).createMachine({
    id: "agent",

    // initial: the state the machine starts in when the actor is created.
    initial: "idle",

    // context: the machine's shared data. Any state can read it;
    // only `assign` actions can write to it (immutable updates).
    context: {
        messages: [],
    },

    states: {
        idle: {
            // on: maps event names to transitions.
            // When this state receives a MESSAGE event, transition to "greetings".
            on: {
                MESSAGE: {
                    target: "greetings",
                    actions: "appendUserMessage",
                },
            },
        },

        greetings: {
            invoke: {
                src: "callLLM",
                input: () => ({
                    messages: [],
                    systemPrompt: GREETINGS_SYSTEM_PROMPT,
                }),
                onDone: {
                    target: "improvise",
                    actions: [
                        ({ event }: { event: { output: string } }) => {
                            console.log(`\n${event.output}\n`);
                        },
                        assign({
                            messages: ({ context, event }) => [
                                ...context.messages,
                                { role: "assistant" as const, content: event.output },
                            ],
                        }),
                        raise({ type: "PARTIALLY_RESPONDED" }),
                    ],
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

        // A compound state: has its own child states (listening, thinking).
        // From the outside, other states only see "improvise" — the children are
        // an internal concern.
        improvise: {
            initial: "listening",
            states: {
                thinking: {
                    // invoke: starts an actor (async service) when this state is entered.
                    // The machine stays in this state until the actor completes.
                    // Does not handle MESSAGE — the agent is busy processing.
                    // src: references the named actor from setup().
                    // input: data passed to the actor — here, the conversation history.
                    invoke: {
                        src: "callLLM",
                        input: ({ context }) => ({
                            messages: context.messages,
                            systemPrompt: IMPROVISE_SYSTEM_PROMPT,
                        }),

                        // onDone: transition taken when the invoked actor resolves.
                        // event.output contains the resolved value (the LLM reply).
                        onDone: {
                            target: "listening",
                            actions: [
                                ({ event }) => {
                                    console.log(`\n${event.output}\n`);
                                },
                                assign({
                                    messages: ({ context, event }) => [
                                        ...context.messages,
                                        { role: "assistant" as const, content: event.output },
                                    ],
                                }),
                            ],
                        },

                        // onError: transition taken when the invoked actor rejects.
                        // event.error contains the thrown error.
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
            },
        },
    },
});
