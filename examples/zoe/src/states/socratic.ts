import { defineMode } from "@eduardorenani/atlasjs";
import type { ModeResult } from "@eduardorenani/atlasjs";

import { chat } from "../llm-client.js";
import type { Message } from "../llm-client.js";
import type { AgentEvents, SocraticContext } from "../types.js";

// SPEC 011 §The model: the former `socratic` compound (teaching + listening +
// evaluating) collapses into ONE active leaf. Work and wait are now temporally
// ordered PHASES of a single mode, not three sibling nodes:
//   - dry-run entry / `stay:"replay"` (no event) → TEACH, then `stay:"waitOnEvent"`.
//   - a MESSAGE arrives → EVALUATE the reply:
//       - understood            → { outcome: "achieved" } → END → "classifying".
//       - abandoned / over-cap  → { outcome: "abandoned" } → END → "classifying".
//       - not understood        → { stay: "replay" } → re-teach (bumps evalRetries).

// ── teach: explain the topic and pose a check-question ───────────────
const TEACH_SYSTEM_PROMPT = [
    "Voce e Zoe, um assistente educacional.",
    "Seu objetivo e ensinar o usuario sobre o topico solicitado.",
    "Explique o conceito de forma clara e acessivel em portugues do Brasil.",
    "Ao final da explicacao, faca uma pergunta de contra-prova para verificar se o usuario entendeu.",
    "A pergunta deve testar a compreensao real, nao apenas a memoria.",
    "Se o historico da conversa mostra que o usuario ja recebeu uma explicacao anterior e respondeu de forma incorreta, incompleta, ou disse que nao sabe, re-explique o conceito de outro angulo (use uma analogia diferente, parta de outra entrada, ou simplifique a abordagem) e faca uma nova pergunta de contra-prova.",
    "Nao use ferramentas. Responda apenas com texto.",
].join(" ");

// ── evaluate: judge the user's reply to the check-question ───────────
const EVALUATE_SYSTEM_PROMPT = [
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

// Circuit breaker: once `evalRetries` reaches this many unusable / failed
// evaluations, abandon instead of re-teaching forever (spec 003 §`socratic`).
const RETRY_LIMIT = 3;

type SocraticPayload = { messages: Message[] };

export const socratic = defineMode<
    SocraticContext,
    AgentEvents,
    SocraticPayload
>({
    input: ({ context }) => ({ messages: context.messages, evalRetries: context.evalRetries }),
    // SPEC 011: the event types this mode waits on — drives `stay:"waitOnEvent"`.
    events: ["MESSAGE"],
    behavior: async ({ input, event }): Promise<ModeResult<SocraticPayload>> => {
        const { messages, evalRetries } = input as { messages: Message[]; evalRetries: number };

        // Circuit breaker (global guard): once we've re-taught up to the cap,
        // give up — regardless of whether this run is a fresh reply or a replay
        // re-teach. The `stay:"replay"` assign bumps `evalRetries`; checking here
        // (before the event/no-event split) keeps the breaker robust to
        // rehydration and never wastes an extra evaluate/teach past the cap.
        if (evalRetries >= RETRY_LIMIT) {
            return { outcome: "abandoned", payload: { messages } };
        }

        // SPEC 011: active behavior sees `event: AgentEvents | undefined` —
        // narrow with `event?.type`. An event present means the user replied.
        if (event?.type === "MESSAGE") {
            const withReply: Message[] = [...messages, { role: "user", content: event.text }];

            const result = await chat(withReply, EVALUATE_SYSTEM_PROMPT);
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
                // Unparseable output → treat as not understood → re-teach.
                // SPEC 011: `stay:"replay"` re-runs now (no event) → teach phase.
                return { stay: "replay", payload: { messages: withReply } };
            }

            if (judgment === "understood") {
                return { outcome: "achieved", payload: { messages: withReply } };
            }
            if (judgment === "abandoned") {
                return { outcome: "abandoned", payload: { messages: withReply } };
            }
            // "not_understood" or "unknown" → re-teach via replay.
            return { stay: "replay", payload: { messages: withReply } };
        }

        // SPEC 011: no event = dry-run entry OR a `stay:"replay"` re-teach
        // (active replay carries NO event). Teach, then wait for the reply.
        const replied = await chat(messages, TEACH_SYSTEM_PROMPT);
        const last = replied[replied.length - 1];
        if (last && last.role === "assistant" && last.content !== null) {
            console.log(`\n${last.content}\n`);
        }
        // SPEC 011: `stay:"waitOnEvent"` → park, re-run on the next MESSAGE.
        return { stay: "waitOnEvent", payload: { messages: [...messages, ...replied] } };
    },
    routes: {
        // On exit, reset `evalRetries` so the next socratic session starts
        // fresh — as the old compound-`local` slot did per-entry (DD-018).
        // Here the counter lives on root context, so the reset is explicit.
        achieved: {
            target: "classifying",
            assign: ({ payload }) => ({ messages: payload.messages, evalRetries: 0 }),
        },
        abandoned: {
            target: "classifying",
            assign: ({ payload }) => ({ messages: payload.messages, evalRetries: 0 }),
        },
    },
    // SPEC 011: `stay` holds continuations (assign only, no target).
    stay: {
        // re-teach: persist the appended reply and bump the circuit-breaker.
        replay: {
            assign: ({ context, payload }) => ({
                messages: payload.messages,
                evalRetries: context.evalRetries + 1,
            }),
        },
        // taught: persist the assistant's explanation before parking.
        waitOnEvent: {
            assign: ({ payload }) => ({ messages: payload.messages }),
        },
    },
});
