// Atlas — mode-based agent orchestration.
//
// Spec: docs/specs/004-xstate-agent-wrapper.md
//       docs/specs/005-agent-deps-and-stringifiable-context.md
//       docs/specs/009-snapshot-aware-rehydration.md
//       docs/specs/012-xstate-containment.md
// Tasks: docs/specs/004-tasks.md

export { defineMode } from "./defineMode.ts";
export { defineCompoundMode } from "./defineCompoundMode.ts";
export { defineAgent } from "./defineAgent.ts";
export { startAgent } from "./startAgent.ts";
export { END, RE_THROW } from "./types.ts";
export type {
    // SPEC 011: ModeResult/Stay/StayMap replace ModeOutput/EventHandlers.
    ModeResult,
    Outcome,
    Stay,
    Mode,
    CompoundMode,
    ModeConfig,
    RunModeConfig,
    EventModeConfig,
    CompoundModeConfig,
    AgentConfig,
    ModesMap,
    CompoundContext,
    Agent,
    Routes,
    StayMap,
    RouteList,
    RouteTarget,
    ErrorRouteTarget,
    JsonPrimitive,
    JsonValue,
    JsonObject,
    JsonArray,
    JsonCompatible,
    AgentActor,
    AgentSnapshot,
    AgentInspectionEvent,
    AgentErrorInfo,
    StartAgentOptions,
} from "./types.ts";
