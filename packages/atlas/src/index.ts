// Atlas — XState wrapper for AI agent orchestration.
//
// Spec: docs/specs/004-xstate-agent-wrapper.md
// Tasks: docs/specs/004-tasks.md

export { defineLeafMode } from "./defineLeafMode.ts";
export { defineMode } from "./defineMode.ts";
export { defineAgent } from "./defineAgent.ts";
export { END, RE_THROW } from "./types.ts";
export type {
    ModeOutput,
    Outcome,
    LeafMode,
    Mode,
    LeafModeConfig,
    ActiveLeafModeConfig,
    PassiveLeafModeConfig,
    ModeConfig,
    AgentConfig,
    StatesMap,
    CompoundContext,
    Routes,
    RouteList,
    RouteTarget,
    ErrorRouteTarget,
    EventHandlers,
} from "./types.ts";
