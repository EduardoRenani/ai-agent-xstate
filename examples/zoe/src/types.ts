// Spec 004 §"Monorepo Restructure": `ModeOutput` is owned by atlas now.
// This file re-exports it so existing consumers under `examples/zoe/src/`
// keep working without each importing from `atlas` directly.

export type { ModeOutput } from "atlas";

// Agent-level types — shared by every migrated mode and the root machine.
import type { Message } from "./llm-client.js";

export type AgentContext = {
    messages: Message[];
};

export type AgentEvents = { type: "MESSAGE"; text: string };
