// Spec 004 §"Monorepo Restructure": `ModeOutput` is owned by atlas now.
// This file re-exports it so existing consumers under `examples/zoe/src/`
// keep working without each importing from `atlas` directly.

export type { ModeOutput } from "@eduardorenani/atlasjs";

// Agent-level types — shared by every migrated mode and the root machine.
import type { Message } from "./llm-client.js";

export type AgentContext = {
    messages: Message[];
};

export type AgentEvents = { type: "MESSAGE"; text: string };

// Compound-local context view seen by every child of the `socratic` compound
// (spec 003 §`socratic`). `messages` is inherited live from the global context;
// `evalRetries` is socratic-local telemetry that the global context never sees.
export type SocraticContext = Pick<AgentContext, "messages"> & {
    evalRetries: number;
};
