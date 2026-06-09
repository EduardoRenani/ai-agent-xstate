import { defineMode } from "@eduardorenani/atlasjs";
import type { ModeResult } from "@eduardorenani/atlasjs";

import type { Message } from "../llm-client.js";
import type { AgentContext, AgentEvents } from "../types.js";

// Root passive leaf — sits idle until a `MESSAGE` event arrives, appends the
// user's text to the conversation, and hands off to the classifier.
//
// SPEC 011 §The model: `start: "event"` — event-driven. Entering PARKS; the
// behavior runs only when a declared event arrives. The old `appendUserMessage`
// named action moves INTO the behavior, which now receives the waking event.
export const listening = defineMode<AgentContext, AgentEvents, { messages: Message[] }>({
    // SPEC 011: `start: "event"` → parks on entry, runs only on a declared event.
    start: "event",
    // SPEC 011: the event types this mode may wait on (drives the park).
    events: ["MESSAGE"],
    input: ({ context }) => ({ messages: context.messages }),
    // SPEC 011: passive behavior receives `event: AgentEvents` — never
    // undefined (no dry run), so no guard is needed.
    behavior: async ({ input, event }): Promise<ModeResult<{ messages: Message[] }>> => {
        const { messages } = input as { messages: Message[] };
        const updated: Message[] = [...messages, { role: "user", content: event.text }];
        return { outcome: "achieved", payload: { messages: updated } };
    },
    routes: {
        achieved: {
            target: "classifying",
            assign: ({ payload }) => ({ messages: payload.messages }),
        },
        abandoned: { target: "classifying" },
    },
});
