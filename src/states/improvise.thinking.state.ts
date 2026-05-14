import { fromPromise } from "xstate";
import { chat } from "../openrouter.js";
import type { Message, ToolDefinition } from "../openrouter.js";

const SYSTEM_PROMPT = [
    "Você é Atlas, um assistente de propósito geral.",
    "Seu tom é amigável e direto.",
    "Responda sempre em português do Brasil.",
    "Responda às perguntas do usuário de forma útil e concisa.",
].join(" ");

const TOOLS: ToolDefinition[] = [
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

export const improviseThinkingNode = fromPromise(
    async ({ input }: { input: { messages: Message[] } }): Promise<Message[]> => {
        const messages = [...input.messages];
        const newMessages: Message[] = [];

        while (true) {
            const response = await chat(messages, SYSTEM_PROMPT, TOOLS);

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
    }
);
