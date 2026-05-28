import { defineMode, END } from "@eduardorenani/atlasjs";
import type { ModeOutput } from "@eduardorenani/atlasjs";

import { chat } from "../llm-client.js";
import type { Message } from "../llm-client.js";
import type { AgentEvents, SocraticContext } from "../types.js";

const SYSTEM_PROMPT = [
    "Voce e Zoe, um assistente educacional avaliando a resposta do usuario a uma pergunta de contra-prova.",
    "Sua unica funcao e analisar a conversa e decidir um de tres resultados. Voce NAO fala com o usuario.",
    "",
    "Responda APENAS com JSON neste formato exato:",
    '{"judgment": "understood" | "not_understood" | "abandoned"}',
    "",
    "Regras:",
    '- "understood": o usuario demonstrou compreensao correta do conceito.',
    '- "not_understood": a resposta esta incorreta, incompleta, ou o usuario disse que nao sabe.',
    '- "abandoned": o usuario pediu explicitamente para parar, mudar de assunto, ou nao quer continuar a verificacao.',
    "",
    "Retorne APENAS o JSON, sem markdown, sem code blocks, sem texto extra, sem campo feedback.",
].join("\n");

// Spec 003 §`socratic.evaluating` shape: the model produces one of three
// judgments, mapped to a wrapper outcome:
//   - "understood"     → achieved + { understood: true  }  → END (compound exits)
//   - "not_understood" → achieved + { understood: false }  → "teaching"
//   - "abandoned"      → abandoned + { understood: false } → END (compound exits)
// Anything else (invalid JSON, transport error, unknown judgment) → retry,
// which the wrapper self-loops on this leaf per DD-014. Spec 008 lets us
// use the `abandoned` bucket directly — the prior payload-only encoding
// (everything under `achieved`) was a workaround for the missing bucket.
type EvalPayload = { understood: boolean };

// Circuit-breaker: once the compound-local `evalRetries` reaches this many
// unusable model outputs, stop self-looping and bail out via `abandoned` so
// the socratic loop terminates instead of retrying forever (spec 003
// §`socratic`). The counter resets per socratic session via DD-018.
const RETRY_LIMIT = 3;

export const socraticEvaluating = defineMode<SocraticContext, AgentEvents, EvalPayload>({
    input: ({ context }) => ({ messages: context.messages, evalRetries: context.evalRetries }),
    behavior: async ({ input }): Promise<ModeOutput<EvalPayload>> => {
        const { messages, evalRetries } = input as { messages: Message[]; evalRetries: number };
        
        if (evalRetries >= RETRY_LIMIT) {
            return { outcome: "abandoned", payload: { understood: false } };
        }
        
        const result = await chat(messages, SYSTEM_PROMPT);
        const last = result[result.length - 1];
        if (!last || last.role !== "assistant" || last.content === null) {
            throw new Error("Socratic evaluating: unexpected response from chat()");
        }

        let judgment: "understood" | "not_understood" | "abandoned" | "unknown" = "unknown";
        try {
            const parsed = JSON.parse(last.content) as { judgment: string };
            if (
                parsed.judgment === "understood" ||
                parsed.judgment === "not_understood" ||
                parsed.judgment === "abandoned"
            ) {
                judgment = parsed.judgment;
            }
        } catch {
            return { outcome: "retry", payload: { understood: false } };
        }

        if (judgment === "understood") {
            return { outcome: "achieved", payload: { understood: true } };
        }
        if (judgment === "not_understood") {
            return { outcome: "achieved", payload: { understood: false } };
        }
        if (judgment === "abandoned") {
            return { outcome: "abandoned", payload: { understood: false } };
        }
        return { outcome: "retry", payload: { understood: false } };
    },
    routes: {
        achieved: [
            { when: (p) => p.understood, target: END },
            { target: "teaching" },
        ],
        // retry self-loops the leaf (DD-014). The `assign` runs before the
        // wrapper re-invokes `behavior`, bumping the compound-local counter —
        // a retry-scoped write to `socratic`'s local slot (spec 008 §RetryEntry).
        retry: { assign: ({ context }) => ({ evalRetries: context.evalRetries + 1 }) },
        abandoned: { target: END },
    },
});
