import { fromPromise } from "xstate";
import { chat } from "../llm-client.js";
import type { Message } from "../llm-client.js";
import type { ModeOutput } from "../types.js";

type ClassificationPayload = {
    intent: "greetings" | "socratic" | "improvise" | "none";
};

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

// Classification is an analytical task, not a conversation. Format the
// conversation history as data inside a single user message so the model
// always has a clear prompt to respond to. Tool-related messages (tool_calls,
// tool results) are stripped — the classifier only needs conversational content.
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

export const classifyingMode = fromPromise(
    async ({ input }: { input: { messages: Message[] } }): Promise<ModeOutput<ClassificationPayload>> => {
        // First message detection: exactly one user message and no assistant messages.
        const userMessages = input.messages.filter((m) => m.role === "user");
        const assistantMessages = input.messages.filter((m) => m.role === "assistant");
        if (userMessages.length === 1 && assistantMessages.length === 0) {
            return { outcome: "achieved", payload: { intent: "greetings" } };
        }

        // Classification via LLM. The conversation is formatted as data in a
        // single user message — classification is analytical, not conversational.
        const classificationMessages = formatForClassification(input.messages);
        const result = await chat(classificationMessages, SYSTEM_PROMPT);
        const lastMessage = result[result.length - 1];
        if (!lastMessage || lastMessage.role !== "assistant" || lastMessage.content === null) {
            throw new Error("Classifying: unexpected response from chat()");
        }

        try {
            const parsed = JSON.parse(lastMessage.content) as { intent: string };
            const intent = parsed.intent;
            if (intent === "socratic" || intent === "improvise" || intent === "none") {
                return { outcome: "achieved", payload: { intent } };
            }
            // Unknown intent — default to improvise.
            return { outcome: "achieved", payload: { intent: "improvise" } };
        } catch {
            // Failed to parse — default to improvise.
            return { outcome: "achieved", payload: { intent: "improvise" } };
        }
    }
);
