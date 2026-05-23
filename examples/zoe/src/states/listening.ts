import { defineMode } from "atlas";

import type { AgentContext, AgentEvents } from "../types.js";

// Root passive leaf — sits idle until a `MESSAGE` event arrives, appends
// the user's text to the conversation, and hands off to the classifier.
// Replaces the inline block at machine.ts:42-49.
export const listening = defineMode<AgentContext, AgentEvents>({
    on: {
        MESSAGE: {
            target: "classifying",
            actions: "appendUserMessage",
        },
    },
});
