import { fromPromise } from "xstate";
import { chat } from "../llm-client.js";
import type { Message, Tool } from "../llm-client.js";

const SYSTEM_PROMPT = [
    "Você é Atlas, um assistente de propósito geral.",
    "Seu tom é amigável e direto.",
    "Responda sempre em português do Brasil.",
    "Responda às perguntas do usuário de forma útil e concisa.",
].join(" ");

const TOOLS: Record<string, Tool> = {
    get_current_time: {
        description: "Returns the current date and time in ISO 8601 format.",
        parameters: { type: "object", properties: {}, required: [] },
        execute: () => new Date().toISOString(),
    },
};

export const improviseThinkingNode = fromPromise(
    async ({ input }: { input: { messages: Message[] } }): Promise<Message[]> => {
        return chat(input.messages, SYSTEM_PROMPT, TOOLS);
    }
);
