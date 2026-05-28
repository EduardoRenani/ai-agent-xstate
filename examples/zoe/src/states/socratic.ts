import { defineCompoundMode } from "@eduardorenani/atlasjs";

import { socraticEvaluating } from "./socratic.evaluating.js";
import { socraticListening } from "./socratic.listening.js";
import { socraticTeaching } from "./socratic.teaching.js";
import type { AgentContext, AgentEvents } from "../types.js";

// Replaces the inline compound at machine.ts:102-154.
//
// Flow: teaching → listening (waits for user reply) → evaluating →
//   - achieved + understood   → END (achieved bucket) → "classifying"
//   - achieved + !understood  → back to teaching (handled inside evaluating)
//   - abandoned               → END (abandoned bucket) → "classifying"
//   - retry                   → wrapper self-loops evaluating
export const socratic = defineCompoundMode<
    AgentContext,
    AgentEvents,
    { inherit: readonly ["messages"]; local: { evalRetries: number } },
    {
        teaching: typeof socraticTeaching;
        listening: typeof socraticListening;
        evaluating: typeof socraticEvaluating;
    }
>({
    // `evalRetries` is socratic-local telemetry (spec 003 §`socratic`): the
    // global context never sees it; children read/write `messages` live.
    context: { inherit: ["messages"] as const, local: { evalRetries: 0 } },
    initial: "teaching",
    modes: {
        teaching: socraticTeaching,
        listening: socraticListening,
        evaluating: socraticEvaluating,
    },
    routes: {
        achieved: { target: "classifying" },
        retry: [],
        abandoned: { target: "classifying" },
    },
});
