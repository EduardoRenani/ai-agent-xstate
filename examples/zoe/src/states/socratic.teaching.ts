import { defineMode } from "@eduardorenani/atlasjs";
import type { ModeOutput } from "@eduardorenani/atlasjs";

import { chat } from "../llm-client.js";
import type { Message } from "../llm-client.js";
import type { AgentEvents, SocraticContext } from "../types.js";

const SYSTEM_PROMPT = [
    "Voce e Zoe, um assistente educacional.",
    "Seu objetivo e ensinar o usuario sobre o topico solicitado.",
    "Explique o conceito de forma clara e acessivel em portugues do Brasil.",
    "Ao final da explicacao, faca uma pergunta de contra-prova para verificar se o usuario entendeu.",
    "A pergunta deve testar a compreensao real, nao apenas a memoria.",
    "Se o historico da conversa mostra que o usuario ja recebeu uma explicacao anterior e respondeu de forma incorreta, incompleta, ou disse que nao sabe, re-explique o conceito de outro angulo (use uma analogia diferente, parta de outra entrada, ou simplifique a abordagem) e faca uma nova pergunta de contra-prova.",
    "Nao use ferramentas. Responda apenas com texto.",
].join(" ");

export const socraticTeaching = defineMode<
    SocraticContext,
    AgentEvents,
    { messages: Message[] }
>({
    input: ({ context }) => ({ messages: context.messages }),
    behavior: async ({ input }): Promise<ModeOutput<{ messages: Message[] }>> => {
        const { messages } = input as { messages: Message[] };
        const replied = await chat(messages, SYSTEM_PROMPT);
        const last = replied[replied.length - 1];
        if (last && last.role === "assistant" && last.content !== null) {
            console.log(`\n${last.content}\n`);
        }
        return { outcome: "achieved", payload: { messages: replied } };
    },
    routes: {
        achieved: {
            target: "listening",
            assign: ({ context, payload }) => ({
                messages: [...context.messages, ...payload.messages],
            }),
        },
        retry: [],
        abandoned: { target: "listening" },
    },
});
