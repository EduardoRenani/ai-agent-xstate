import { setup, assign, fromPromise, enqueueActions } from "xstate";
import { chat } from "./openrouter.js";

// ── Types ────────────────────────────────────────────────────────────

export type LLMInput = {
    messages: Array<{ role: "user" | "assistant"; content: string }>;
    systemPrompt: string;
};

// ── Greetings ────────────────────────────────────────────────────────

const GREETINGS_SYSTEM_PROMPT = [
    "Você é Atlas, um assistente de propósito geral.",
    "Analise a mensagem do usuário e responda APENAS com JSON neste formato exato:",
    '{"greeting": "<sua saudação>", "needsFollowUp": <boolean>}',
    "Regras para greeting: cumprimente o usuário em português do Brasil de forma amigável e direta. Nao responder nada alem de cumprimentar",
    "Apresente-se brevemente pelo nome. Não responda perguntas — apenas cumprimente.",
    "Mantenha a saudação curta (1-2 frases).",
    "Regras para needsFollowUp: true se o usuário fez uma pergunta ou pedido além de cumprimentar.",
    'false se o usuário apenas cumprimentou (ex: "oi", "olá", "e aí", "bom dia").',
    "Retorne APENAS o JSON, sem markdown, sem code blocks, sem texto extra.",
].join("\n");

const greetingsNode = fromPromise(async ({ input }: { input: LLMInput }): Promise<{ greeting: string; needsFollowUp: boolean }> => {
    const raw = await chat(input.messages, input.systemPrompt);
    try {
        const parsed = JSON.parse(raw) as { greeting: string; needsFollowUp: boolean };
        return {
            greeting: parsed.greeting,
            needsFollowUp: parsed.needsFollowUp === true,
        };
    } catch {
        return { greeting: raw, needsFollowUp: false };
    }
});

// ── Improvise ────────────────────────────────────────────────────────

const IMPROVISE_SYSTEM_PROMPT = [
    "Você é Atlas, um assistente de propósito geral.",
    "Seu tom é amigável e direto.",
    "Responda sempre em português do Brasil.",
    "Responda às perguntas do usuário de forma útil e concisa.",
].join(" ");

const improviseThinkingNode = fromPromise(async ({ input }: { input: LLMInput }) =>
    chat(input.messages, input.systemPrompt)
);

// ── Machine ──────────────────────────────────────────────────────────

export const agentMachine = setup({
    types: {
        context: {} as {
            messages: Array<{ role: "user" | "assistant"; content: string }>;
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
                    systemPrompt: GREETINGS_SYSTEM_PROMPT,
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
                        if (needsFollowUp) { //Exemplo de Emissão de Evento Condicional (em cima do retorno da LLM)
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
                            systemPrompt: IMPROVISE_SYSTEM_PROMPT,
                        }),
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
