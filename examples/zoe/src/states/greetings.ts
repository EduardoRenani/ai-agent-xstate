import { defineMode } from "atlas";

import { greetingsThinking } from "./greetings.thinking.js";
import type { AgentContext, AgentEvents } from "../types.js";

// Single-substate compound: thinking → END → outer `onDone: "classifying"`.
// Wraps `greetingsThinking` so the leaf can target END (the only way to
// exit a compound) instead of a sibling at the agent root.
export const greetings = defineMode<
    AgentContext,
    AgentEvents,
    undefined,
    { thinking: typeof greetingsThinking }
>({
    initial: "thinking",
    states: { thinking: greetingsThinking },
    onDone: "classifying",
});
