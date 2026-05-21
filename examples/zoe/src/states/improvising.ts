import { defineMode } from "atlas";

import { improvisingThinking } from "./improvising.thinking.js";
import type { AgentContext, AgentEvents } from "../types.js";

// Single-substate compound: thinking → END → outer `onDone: "classifying"`.
export const improvising = defineMode<
    AgentContext,
    AgentEvents,
    undefined,
    { thinking: typeof improvisingThinking }
>({
    initial: "thinking",
    states: { thinking: improvisingThinking },
    onDone: "classifying",
});
