import { defineMode } from "@eduardorenani/atlasjs";
import type { ModeOutput } from "@eduardorenani/atlasjs";

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

// Single-shot leaf mode (spec 003 §`improvising`). Flattened from the former
// single-substate compound for the same reason as `greetings`: no
// MESSAGE-handling substate. The tool loop is internal to the actor (spec 002).
export const improvising = defineMode<
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
            target: "classifying",
            assign: ({ context, payload }) => ({
                messages: [...context.messages, ...payload.messages],
            }),
        },
        retry: [],
        abandoned: { target: "classifying" },
        // On an LLM transport error, log and recover by handing back to the
        // classifier (spec 003 §`improvising`). As a root-level sibling the
        // leaf routes `error` to `classifying` instead of `END`; the log here
        // actually runs (unlike the pre-flatten compound, whose omitted
        // `routes.error` re-threw above the compound and dropped this assign).
        error: {
            target: "classifying",
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
