import { setup, assign, fromPromise, enqueueActions } from "xstate";
import { chat } from "./openrouter.js";
import type { Message, ToolCall, ToolDefinition } from "./openrouter.js";

// ── Types ────────────────────────────────────────────────────────────

export type LLMInput = {
    messages: Message[];
    systemPrompt: string;
    tools?: ToolDefinition[];
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
    const response = await chat(input.messages, input.systemPrompt);
    if (!response.content) {
        throw new Error("Greetings received tool_calls instead of content");
    }
    const raw = response.content;
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

const IMPROVISE_TOOLS: ToolDefinition[] = [
    {
        type: "function",
        function: {
            name: "get_current_time",
            description: "Returns the current date and time in ISO 8601 format.",
            parameters: { type: "object", properties: {}, required: [] },
        },
    },
];

const TOOL_REGISTRY: Record<string, (args: Record<string, unknown>) => string> = {
    get_current_time: () => new Date().toISOString(),
};

const improviseThinkingNode = fromPromise(async ({ input }: { input: LLMInput }): Promise<Message[]> => {
    const messages = [...input.messages];
    const newMessages: Message[] = [];

    while (true) {
        const response = await chat(messages, input.systemPrompt, input.tools);

        if (!response.toolCalls) {
            const assistantMessage: Message = { role: "assistant", content: response.content };
            messages.push(assistantMessage);
            newMessages.push(assistantMessage);
            break;
        }

        const assistantMessage: Message = { role: "assistant", content: null, tool_calls: response.toolCalls };
        messages.push(assistantMessage);
        newMessages.push(assistantMessage);

        for (const toolCall of response.toolCalls) {
            const fn = TOOL_REGISTRY[toolCall.function.name];
            let result: string;
            if (fn) {
                const args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
                result = fn(args);
            } else {
                result = `Unknown tool: ${toolCall.function.name}`;
            }
            const toolMessage: Message = {
                role: "tool",
                content: result,
                tool_call_id: toolCall.id,
            };
            messages.push(toolMessage);
            newMessages.push(toolMessage);
        }
    }

    return newMessages;
});

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
                            tools: IMPROVISE_TOOLS,
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
