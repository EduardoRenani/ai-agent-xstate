// Spec 004 §"Monorepo Restructure": the mode result type is owned by atlas now.
// This file re-exports it so existing consumers under `examples/zoe/src/`
// keep working without each importing from `atlas` directly.
//
// SPEC 011: the behavior's return type is now `ModeResult` (outcome XOR stay),
// superseding the old `ModeOutput`.
export type { ModeResult } from "@eduardorenani/atlasjs";

// Agent-level types — shared by every migrated mode and the root machine.
import type { Message } from "./llm-client.js";

// SPEC 011: `socratic` collapsed from a compound (with `local: { evalRetries }`)
// into a single active leaf. With no compound-local scope, its circuit-breaker
// counter lives on the root context and is threaded via `stay.replay.assign`.
export type AgentContext = {
    messages: Message[];
    evalRetries: number;
};

export type AgentEvents = { type: "MESSAGE"; text: string };

// The `socratic` leaf observes the same root context: `messages` (the live
// transcript) plus `evalRetries` (its circuit breaker).
export type SocraticContext = AgentContext;
