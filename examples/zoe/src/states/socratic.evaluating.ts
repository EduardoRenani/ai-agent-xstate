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
    '{"evaluation": "achieved" | "retry" | "abandoned"}',
    "",
    "Regras:",
    '- "achieved": o usuario demonstrou compreensao correta do conceito.',
    '- "retry": a resposta esta incorreta, incompleta, ou o usuario disse que nao sabe.',
    '- "abandoned": o usuario pediu explicitamente para parar, mudar de assunto, ou nao quer continuar a verificacao.',
    "",
    "Retorne APENAS o JSON, sem markdown, sem code blocks, sem texto extra, sem campo feedback.",
].join("\n");

// The model decides one of three results, but only ONE of them maps to the
// wrapper's structural retry (which self-loops on the same leaf). The
// originals "retry" and "achieved" / "abandoned" each branch to a DIFFERENT
// sibling — retry goes back to `teaching`, achieved/abandoned exit via END.
// Wrapper retry can't redirect to a sibling, so we encode the three results
// in the payload and dispatch from `routes.achieved` instead.
type EvalResult = "achieved" | "retry" | "abandoned";
type EvalPayload = { result: EvalResult };

export const socraticEvaluating = defineMode<AgentContext, AgentEvents, EvalPayload>({
    input: ({ context }) => ({ messages: context.messages }),
    behavior: async ({ input }): Promise<ModeOutput<EvalPayload>> => {
        const { messages } = input as { messages: Message[] };
        const result = await chat(messages, SYSTEM_PROMPT);
        const last = result[result.length - 1];
        if (!last || last.role !== "assistant" || last.content === null) {
            throw new Error("Socratic evaluating: unexpected response from chat()");
        }

        let evaluation: EvalResult = "retry";
        try {
            const parsed = JSON.parse(last.content) as { evaluation: string };
            if (parsed.evaluation === "achieved" || parsed.evaluation === "abandoned") {
                evaluation = parsed.evaluation;
            }
        } catch {
            // fall back to retry — the original .mode.ts file defaulted the
            // same way (socratic.evaluating.mode.ts:36-40).
        }

        return { outcome: "achieved", payload: { result: evaluation } };
    },
    routes: {
        // Match the original onDone array (machine.ts:136-148) — first match
        // wins. `retry` from the model loops back to `teaching`; achieved
        // and abandoned both exit the compound through END.
        achieved: [
            { when: (p) => p.result === "achieved",  target: END },
            { when: (p) => p.result === "abandoned", target: END },
            { target: "teaching" },
        ],
        retry: [],
        abandoned: { target: END },
    },
});
