import { fromPromise } from "xstate";
import { chat } from "../llm-client.js";
import type { Message } from "../llm-client.js";
import type { ModeGoalEvaluation } from "../types.js";

const SYSTEM_PROMPT = [
    "Voce e Atlas, um assistente educacional avaliando a resposta do usuario.",
    "Analise a conversa e determine se o usuario demonstrou compreensao do conceito ensinado.",
    "Responda APENAS com JSON neste formato exato:",
    '{"evaluation": "achieved" | "retry" | "abandoned", "feedback": "<seu feedback>"}',
    "",
    "Regras:",
    '- "achieved": o usuario demonstrou compreensao correta do conceito.',
    '- "retry": a resposta esta incorreta ou incompleta. De feedback construtivo.',
    '- "abandoned": o usuario pediu para parar, mudar de assunto, ou nao quer continuar a verificacao.',
    "",
    "O feedback deve ser em portugues do Brasil, amigavel e construtivo.",
    "Retorne APENAS o JSON, sem markdown, sem code blocks, sem texto extra.",
].join("\n");

export const socraticEvaluatingNode = fromPromise(
    async ({ input }: { input: { messages: Message[] } }): Promise<{ evaluation: ModeGoalEvaluation; messages: Message[] }> => {
        const result = await chat(input.messages, SYSTEM_PROMPT);
        const lastMessage = result[result.length - 1];
        if (!lastMessage || lastMessage.role !== "assistant" || lastMessage.content === null) {
            throw new Error("Socratic evaluating: unexpected response from chat()");
        }

        try {
            const parsed = JSON.parse(lastMessage.content) as { evaluation: string; feedback: string };
            const evaluation = parsed.evaluation;
            if (evaluation === "achieved" || evaluation === "retry" || evaluation === "abandoned") {
                const feedback = parsed.feedback;
                if (feedback) {
                    console.log(`\n${feedback}\n`);
                }
                return {
                    evaluation,
                    messages: [{ role: "assistant" as const, content: feedback }],
                };
            }
            // Unknown evaluation — default to retry.
            const fallbackFeedback = parsed.feedback ?? lastMessage.content;
            if (fallbackFeedback) {
                console.log(`\n${fallbackFeedback}\n`);
            }
            return {
                evaluation: "retry",
                messages: [{ role: "assistant" as const, content: fallbackFeedback }],
            };
        } catch {
            // Failed to parse — default to retry with raw content as feedback.
            console.log(`\n${lastMessage.content}\n`);
            return {
                evaluation: "retry",
                messages: [{ role: "assistant" as const, content: lastMessage.content }],
            };
        }
    }
);
