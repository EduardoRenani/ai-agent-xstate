import { defineAgent } from "@eduardorenani/atlasjs";

import { classifying } from "./states/classifying.js";
import { greetings } from "./states/greetings.js";
import { improvising } from "./states/improvising.js";
import { listening } from "./states/listening.js";
import { socratic } from "./states/socratic.js";
import type { AgentContext, AgentEvents } from "./types.js";

// SPEC 011: `socratic` is now a single active leaf (not a compound), and
// `listening` is a `start: "event"` mode whose behavior appends the user
// message — so the former `appendUserMessage` named action is gone.
export const agentMachine = defineAgent<
    AgentContext,
    AgentEvents,
    {
        listening: typeof listening;
        classifying: typeof classifying;
        greetings: typeof greetings;
        socratic: typeof socratic;
        improvising: typeof improvising;
    }
>({
    id: "agent",
    initial: "listening",
    context: { messages: [], evalRetries: 0 },
    events: {} as AgentEvents,
    modes: { listening, classifying, greetings, socratic, improvising },
});
