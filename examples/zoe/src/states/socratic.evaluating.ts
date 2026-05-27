import { defineMode, END } from "@eduardorenani/atlasjs";
import type { ModeOutput } from "@eduardorenani/atlasjs";

import { chat } from "../llm-client.js";
import type { Message } from "../llm-client.js";
import type { AgentContext, AgentEvents } from "../types.js";

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

export const socraticEvaluating = defineMode<AgentContext, AgentEvents, EvalPayload>({
    input: ({ context }) => ({ messages: context.messages }),
    behavior: async ({ input }): Promise<ModeOutput<EvalPayload>> => {
        const { messages } = input as { messages: Message[] };
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
            // Unparseable response → judgment stays "unknown" → wrapper retry.
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
        // Spec 003 §`socratic.evaluating` "onDone guards": branch by
        // `payload.understood` within achieved; abandoned bubbles out via
        // the dedicated bucket; retry self-loops with no entry needed.
        achieved: [
            { when: (p) => p.understood, target: END },
            { target: "teaching" },
        ],
        retry: [],
        abandoned: { target: END },
    },
});
