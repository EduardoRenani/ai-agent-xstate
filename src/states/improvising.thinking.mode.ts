import { fromPromise } from "xstate";
import { chat } from "../llm-client.js";
import type { Message, Tool } from "../llm-client.js";
import type { ModeOutput } from "../types.js";

const SYSTEM_PROMPT = [
    "Voce e Atlas, um assistente de proposito geral.",
    "Seu tom e amigavel e direto.",
    "Responda sempre em portugues do Brasil.",
    "Responda as perguntas do usuario de forma util e concisa.",
].join(" ");

const TOOLS: Record<string, Tool> = {
    get_current_time: {
        description: "Returns the current date and time in ISO 8601 format.",
        parameters: { type: "object", properties: {}, required: [] },
        execute: () => new Date().toISOString(),
    },
};

export const improvisingThinkingMode = fromPromise(
    async ({ input }: { input: { messages: Message[] } }): Promise<ModeOutput<{ messages: Message[] }>> => {
        const messages = await chat(input.messages, SYSTEM_PROMPT, TOOLS);
        const last = messages[messages.length - 1];
        if (last && last.role === "assistant" && last.content !== null) {
            console.log(`\n${last.content}\n`);
        }
        return { outcome: "achieved", payload: { messages } };
    }
);
