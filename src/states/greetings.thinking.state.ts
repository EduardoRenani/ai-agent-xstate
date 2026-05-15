import { fromPromise } from "xstate";
import { chat } from "../llm-client.js";
import type { Message } from "../llm-client.js";
import type { ModeOutput } from "../types.js";

const SYSTEM_PROMPT = [
    "Voce e Atlas, um assistente de proposito geral.",
    "Cumprimente o usuario em portugues do Brasil de forma amigavel e direta.",
    "Apresente-se brevemente pelo nome.",
    "Mantenha a saudacao curta (1-2 frases).",
    "IMPORTANTE: Apenas cumprimente. Se o usuario fez uma pergunta ou pedido junto da saudacao, ignore completamente — nao responda, nao mencione, nao reconheca. Outro modulo cuidara disso.",
].join(" ");

export const greetingsThinkingNode = fromPromise(
    async ({ input }: { input: { messages: Message[] } }): Promise<ModeOutput<{ messages: Message[] }>> => {
        const messages = await chat(input.messages, SYSTEM_PROMPT);
        const last = messages[messages.length - 1];
        if (last && last.role === "assistant" && last.content !== null) {
            console.log(`\n${last.content}\n`);
        }
        return { outcome: "achieved", payload: { messages } };
    }
);
