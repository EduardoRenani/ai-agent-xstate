import { fromPromise } from "xstate";
import { chat } from "../llm-client.js";
import type { Message } from "../llm-client.js";

const SYSTEM_PROMPT = [
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

export const greetingsNode = fromPromise(
    async ({ input }: { input: { messages: Message[] } }): Promise<{ greeting: string; needsFollowUp: boolean }> => {
        const result = await chat(input.messages, SYSTEM_PROMPT);
        const lastMessage = result[result.length - 1];
        if (!lastMessage || lastMessage.role !== "assistant" || lastMessage.content === null) {
            throw new Error("Greetings: unexpected response from chat()");
        }
        const raw = lastMessage.content;
        try {
            const parsed = JSON.parse(raw) as { greeting: string; needsFollowUp: boolean };
            return {
                greeting: parsed.greeting,
                needsFollowUp: parsed.needsFollowUp === true,
            };
        } catch {
            return { greeting: raw, needsFollowUp: false };
        }
    }
);
