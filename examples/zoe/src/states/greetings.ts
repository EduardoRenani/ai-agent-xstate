import { defineCompoundMode } from "atlas";

import { greetingsThinking } from "./greetings.thinking.js";
import type { AgentContext, AgentEvents } from "../types.js";

// Single-substate compound: thinking → END → outer `onDone: "classifying"`.
// Wraps `greetingsThinking` so the leaf can target END (the only way to
// exit a compound) instead of a sibling at the agent root.
export const greetings = defineCompoundMode<
    AgentContext,
    AgentEvents,
    undefined,
    { thinking: typeof greetingsThinking }
>({
    initial: "thinking",
    modes: { thinking: greetingsThinking },
    onDone: "classifying",
});
