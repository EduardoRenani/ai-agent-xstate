import { defineMode } from "atlas";

import type { AgentContext, AgentEvents } from "../types.js";

// Passive leaf inside `socratic`: waits for the user's reply, appends it
// to the transcript, and hands off to the evaluator. Mirrors the inline
// block at machine.ts:122-129.
export const socraticListening = defineMode<AgentContext, AgentEvents>({
    on: {
        MESSAGE: {
            target: "evaluating",
            actions: "appendUserMessage",
        },
    },
});
