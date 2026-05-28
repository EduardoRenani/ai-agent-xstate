import { defineCompoundMode } from "@eduardorenani/atlasjs";

import { improvisingThinking } from "./improvising.thinking.js";
import type { AgentContext, AgentEvents } from "../types.js";

// Single-substate compound: thinking → END → outer routes back to
// "classifying".
export const improvising = defineCompoundMode<
    AgentContext,
    AgentEvents,
    undefined,
    { thinking: typeof improvisingThinking }
>({
    initial: "thinking",
    modes: { thinking: improvisingThinking },
    routes: {
        achieved: { target: "classifying" },
        retry: [],
        abandoned: { target: "classifying" },
    },
});
