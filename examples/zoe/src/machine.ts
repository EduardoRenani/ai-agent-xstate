import { defineAgent } from "@eduardorenani/atlasjs";

import { classifying } from "./states/classifying.js";
import { greetings } from "./states/greetings.js";
import { improvising } from "./states/improvising.js";
import { listening } from "./states/listening.js";
import { socratic } from "./states/socratic.js";
import type { AgentContext, AgentEvents } from "./types.js";

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
    context: { messages: [] },
    events: {} as AgentEvents,
    actions: {
        appendUserMessage: ({ context, event }) => ({
            messages: [
                ...context.messages,
                { role: "user" as const, content: event.text },
            ],
        }),
    },
    modes: { listening, classifying, greetings, socratic, improvising },
});
