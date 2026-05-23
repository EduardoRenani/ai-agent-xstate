import { defineMode, END } from "atlas";
import type { ModeOutput } from "atlas";

import { chat } from "../llm-client.js";
import type { Message, Tool } from "../llm-client.js";
import type { AgentContext, AgentEvents } from "../types.js";

const SYSTEM_PROMPT = [
    "Voce e Zoe, um assistente de proposito geral.",
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

export const improvisingThinking = defineMode<
    AgentContext,
    AgentEvents,
    { messages: Message[] }
>({
    input: ({ context }) => ({ messages: context.messages }),
    behavior: async ({ input }): Promise<ModeOutput<{ messages: Message[] }>> => {
        const { messages } = input as { messages: Message[] };
        const replied = await chat(messages, SYSTEM_PROMPT, TOOLS);
        const last = replied[replied.length - 1];
        if (last && last.role === "assistant" && last.content !== null) {
            console.log(`\n${last.content}\n`);
        }
        return { outcome: "achieved", payload: { messages: replied } };
    },
    routes: {
        achieved: {
            target: END,
            assign: ({ context, payload }) => ({
                messages: [...context.messages, ...payload.messages],
            }),
        },
        retry: [],
        abandoned: { target: END },
        // Preserve pre-migration behavior (machine.ts:174-183): log the
        // error and exit the compound. The wrapper's onError-aware routing
        // replaces the hand-written `onError` block; the log moves into
        // `assign` (its only side effect was the console.error).
        error: {
            target: END,
            assign: ({ context, error }) => {
                console.error(
                    "\nError calling LLM:",
                    error instanceof Error ? error.message : String(error),
                    "\n",
                );
                return { messages: context.messages };
            },
        },
    },
});
