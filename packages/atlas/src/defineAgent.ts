// `defineAgent` — constructs the root XState machine.
//
// Spec: docs/specs/004-xstate-agent-wrapper.md §`defineAgent`.
//
// `defineAgent` is the only constructor that touches `xstate`: it returns an
// `AnyStateMachine` so the rest of the project (`createActor`, the inspector,
// existing tests) keeps working unchanged. The lowering itself lives in
// `compile.ts`.

import type { AnyStateMachine } from "xstate";

import { compile } from "./compile.ts";
import type { AgentConfig, StatesMap } from "./types.ts";

export function defineAgent<
    TContext,
    TEvents extends { type: string },
    TStates extends StatesMap<TContext, TEvents>,
>(config: AgentConfig<TContext, TEvents, TStates>): AnyStateMachine {
    return compile(config);
}
