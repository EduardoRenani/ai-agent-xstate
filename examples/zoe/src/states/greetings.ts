import { defineMode } from "@eduardorenani/atlasjs";
import type { ModeResult } from "@eduardorenani/atlasjs";

import { chat } from "../llm-client.js";
import type { Message } from "../llm-client.js";
import type { AgentContext, AgentEvents } from "../types.js";

const SYSTEM_PROMPT = [
    "Voce e Zoe, um assistente de proposito geral.",
    "Cumprimente o usuario em portugues do Brasil de forma amigavel e direta.",
    "Apresente-se brevemente pelo nome.",
    "Mantenha a saudacao curta (1-2 frases).",
    "IMPORTANTE: Apenas cumprimente. Se o usuario fez uma pergunta ou pedido junto da saudacao, ignore completamente — nao responda, nao mencione, nao reconheca. Outro modulo cuidara disso.",
].join(" ");

// Single-shot leaf mode (spec 003 §`greetings`). It has no MESSAGE-handling
// substate, so wrapping it in a compound bought nothing — the leaf routes its
// `achieved` outcome straight to the sibling `classifying`, exactly as
// `classifying` routes to its sibling modes.
export const greetings = defineMode<
    AgentContext,
    AgentEvents,
    { messages: Message[] }
>({
    input: ({ context }) => ({ messages: context.messages }),
    // SPEC 011: active mode entered by a transition — ignores `event`.
    behavior: async ({ input }): Promise<ModeResult<{ messages: Message[] }>> => {
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
            target: "classifying",
            assign: ({ context, payload }) => ({
                messages: [...context.messages, ...payload.messages],
            }),
        },
        // SPEC 011: no `retry` bucket — `routes` holds only exits.
        abandoned: { target: "classifying" },
    },
});
