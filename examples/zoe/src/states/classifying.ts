import { defineMode } from "@eduardorenani/atlasjs";
import type { ModeOutput } from "@eduardorenani/atlasjs";

import { chat } from "../llm-client.js";
import type { Message } from "../llm-client.js";
import type { AgentContext, AgentEvents } from "../types.js";

type Intent = "greetings" | "socratic" | "improvise" | "none";
type ClassifierPayload = { intent: Intent };

const SYSTEM_PROMPT = [
    "You are a conversation classifier.",
    "You will receive a conversation transcript inside <conversation> tags.",
    "Analyze it and determine the user's current intent.",
    "Classify as one of:",
    '- "socratic" — the user wants to learn or understand something (asks to explain, teach, clarify a concept).',
    '- "improvise" — general question, task, conversation, or anything else that needs a response.',
    '- "none" — there is no unaddressed user content; the conversation is idle (e.g. the assistant fully addressed the user\'s request).',
    "",
    "Respond ONLY with JSON in this exact format:",
    '{"intent": "socratic" | "improvise" | "none"}',
    "No markdown, no code blocks, no extra text.",
].join("\n");

function formatForClassification(messages: Message[]): Message[] {
    const lines = messages
        .filter((m): m is { role: "user"; content: string } | { role: "assistant"; content: string } =>
            (m.role === "user") || (m.role === "assistant" && m.content !== null)
        )
        .map((m) => `${m.role}: ${m.content}`);

    return [
        {
            role: "user" as const,
            content: `<conversation>\n${lines.join("\n")}\n</conversation>\n\nClassify the user's current intent.`,
        },
    ];
}

export const classifying = defineMode<AgentContext, AgentEvents, ClassifierPayload>({
    input: ({ context }) => ({ messages: context.messages }),
    behavior: async ({ input }): Promise<ModeOutput<ClassifierPayload>> => {
        const { messages } = input as { messages: Message[] };

        // First-message fast-path: a single user message and no assistant
        // history maps deterministically to "greetings".
        const userMessages = messages.filter((m) => m.role === "user");
        const assistantMessages = messages.filter((m) => m.role === "assistant");
        if (userMessages.length === 1 && assistantMessages.length === 0) {
            return { outcome: "achieved", payload: { intent: "greetings" } };
        }

        const classificationMessages = formatForClassification(messages);
        const result = await chat(classificationMessages, SYSTEM_PROMPT);
        const last = result[result.length - 1];
        if (!last || last.role !== "assistant" || last.content === null) {
            throw new Error("Classifying: unexpected response from chat()");
        }

        try {
            const parsed = JSON.parse(last.content) as { intent: string };
            const intent = parsed.intent;
            if (intent === "socratic" || intent === "improvise" || intent === "none") {
                return { outcome: "achieved", payload: { intent } };
            }
            return { outcome: "achieved", payload: { intent: "improvise" } };
        } catch {
            return { outcome: "achieved", payload: { intent: "improvise" } };
        }
    },
    // Routing matches machine.ts:57-73 — first match wins on `payload.intent`,
    // with `improvising` as the unguarded default.
    routes: {
        achieved: [
            { when: (p) => p.intent === "greetings", target: "greetings" },
            { when: (p) => p.intent === "socratic",  target: "socratic" },
            { when: (p) => p.intent === "none",      target: "listening" },
            { target: "improvising" },
        ],
        // The classifier never returns retry / abandoned in practice; the
        // type system requires both keys. Safe fallbacks:
        retry:     [],                       // no-op default
        abandoned: { target: "listening" },  // back to idle on unexpected failure
    },
});
