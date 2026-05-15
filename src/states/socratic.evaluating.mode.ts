import { fromPromise } from "xstate";
import { chat } from "../llm-client.js";
import type { Message } from "../llm-client.js";
import type { ModeOutput } from "../types.js";

const SYSTEM_PROMPT = [
    "Voce e Atlas, um assistente educacional avaliando a resposta do usuario a uma pergunta de contra-prova.",
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

export const socraticEvaluatingMode = fromPromise(
    async ({ input }: { input: { messages: Message[] } }): Promise<ModeOutput<undefined>> => {
        const result = await chat(input.messages, SYSTEM_PROMPT);
        const lastMessage = result[result.length - 1];
        if (!lastMessage || lastMessage.role !== "assistant" || lastMessage.content === null) {
            throw new Error("Socratic evaluating: unexpected response from chat()");
        }

        try {
            const parsed = JSON.parse(lastMessage.content) as { evaluation: string };
            const evaluation = parsed.evaluation;
            if (evaluation === "achieved" || evaluation === "abandoned") {
                return { outcome: evaluation, payload: undefined };
            }
            // Unknown or "retry" — default to retry.
            return { outcome: "retry", payload: undefined };
        } catch {
            // Failed to parse — default to retry.
            return { outcome: "retry", payload: undefined };
        }
    }
);
