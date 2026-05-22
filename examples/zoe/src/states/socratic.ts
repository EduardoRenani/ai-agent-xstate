import { defineMode } from "atlas";

import { socraticEvaluating } from "./socratic.evaluating.js";
import { socraticListening } from "./socratic.listening.js";
import { socraticTeaching } from "./socratic.teaching.js";
import type { AgentContext, AgentEvents } from "../types.js";

// Replaces the inline compound at machine.ts:102-154.
//
// Flow: teaching → listening (waits for user reply) → evaluating →
//   - achieved / abandoned → END → outer `onDone: "classifying"`
//   - retry              → back to teaching (encoded in evaluating's
//                           payload-driven routes; see socratic.evaluating.ts)
export const socratic = defineMode<
    AgentContext,
    AgentEvents,
    undefined,
    {
        teaching: typeof socraticTeaching;
        listening: typeof socraticListening;
        evaluating: typeof socraticEvaluating;
    }
>({
    initial: "teaching",
    modes: {
        teaching: socraticTeaching,
        listening: socraticListening,
        evaluating: socraticEvaluating,
    },
    onDone: "classifying",
});
