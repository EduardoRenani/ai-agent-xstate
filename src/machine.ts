import { setup, assign, fromPromise } from "xstate";
import { chat } from "./openrouter.js";

export const agentMachine = setup({
    // types: declares the TypeScript types for context (shared data) and events
    // (messages the machine can receive). This gives type safety across the machine.
    types: {
        context: {} as {
            messages: Array<{ role: "user" | "assistant"; content: string }>;
        },
        events: {} as { type: "MESSAGE"; text: string },
    },

    // actions: named reusable actions referenced by string in the machine definition.
    actions: {
        appendUserMessage: assign({
            messages: ({ context, event }) => [
                ...context.messages,
                { role: "user" as const, content: event.text },
            ],
        }),
    },

    // actors: named async services the machine can invoke.
    // fromPromise wraps an async function into an actor that XState can manage —
    // starting it when a state is entered and collecting the result via onDone/onError.
    actors: {
        callLLM: fromPromise(
            async ({ input }: { input: Array<{ role: "user" | "assistant"; content: string }> }) => {
                return chat(input);
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
                    // target: the state to transition to.
                    target: "greetings",
                },
            },
        },

        greetings: {
            // Transient state: entry action runs (prints greeting), then
            // always (unconditional, no guard) transitions immediately to improvise.
            // The agent greets and becomes available to listen in one step.
            entry: () => {
                console.log(
                    "\nHello! I'm your AI agent. Ask me anything.\n"
                );
            },
            always: {
                target: "improvise",
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
                        input: ({ context }) => context.messages,

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
                    // The agent is ready for user input.
                    on: {
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
