// Atlas — XState wrapper for AI agent orchestration.
//
// Spec: docs/specs/004-xstate-agent-wrapper.md
//       docs/specs/005-agent-deps-and-stringifiable-context.md
//       docs/specs/009-snapshot-aware-rehydration.md
// Tasks: docs/specs/004-tasks.md

export { defineMode } from "./defineMode.ts";
export { defineCompoundMode } from "./defineCompoundMode.ts";
export { defineAgent } from "./defineAgent.ts";
export { startAgent } from "./startAgent.ts";
export { END, RE_THROW } from "./types.ts";
export type {
    ModeOutput,
    Outcome,
    Mode,
    CompoundMode,
    ModeConfig,
    ActiveModeConfig,
    PassiveModeConfig,
    CompoundModeConfig,
    AgentConfig,
    ModesMap,
    CompoundContext,
    Routes,
    RouteList,
    RouteTarget,
    ErrorRouteTarget,
    EventHandlers,
    JsonPrimitive,
    JsonValue,
    JsonObject,
    JsonArray,
    JsonCompatible,
    AgentActor,
    AgentSnapshot,
    AgentInspectionEvent,
    StartAgentOptions,
} from "./types.ts";
