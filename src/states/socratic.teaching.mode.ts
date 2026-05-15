import { fromPromise } from "xstate";
import { chat } from "../llm-client.js";
import type { Message } from "../llm-client.js";
import type { ModeOutput } from "../types.js";

const SYSTEM_PROMPT = [
    "Voce e Atlas, um assistente educacional.",
    "Seu objetivo e ensinar o usuario sobre o topico solicitado.",
    "Explique o conceito de forma clara e acessivel em portugues do Brasil.",
    "Ao final da explicacao, faca uma pergunta de contra-prova para verificar se o usuario entendeu.",
    "A pergunta deve testar a compreensao real, nao apenas a memoria.",
    "Nao use ferramentas. Responda apenas com texto.",
].join(" ");

export const socraticTeachingMode = fromPromise(
    async ({ input }: { input: { messages: Message[] } }): Promise<ModeOutput<{ messages: Message[] }>> => {
        const messages = await chat(input.messages, SYSTEM_PROMPT);
        const last = messages[messages.length - 1];
        if (last && last.role === "assistant" && last.content !== null) {
            console.log(`\n${last.content}\n`);
        }
        return { outcome: "achieved", payload: { messages } };
    }
);
