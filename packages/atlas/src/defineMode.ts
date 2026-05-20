// `defineMode` — constructs a compound mode (a state with substates).
//
// Spec: docs/specs/004-xstate-agent-wrapper.md §`defineMode` + §Type contract.
//
// Like `defineLeafMode`, this is a thin Phase 3 shell. The generics enforce
// the compound-local context narrowing at the call site: children's
// `TContext` is `LocalContextOf<TParentContext, TCtx>`. The compile step in
// `compile.ts` lowers the carrier to XState states later.

import type {
    CompoundContext,
    LocalContextOf,
    Mode,
    ModeConfig,
    StatesMap,
} from "./types.ts";

export type ModeCarrier<TParentContext, TEvents extends { type: string }> = {
    readonly __kind: "compound";
    // Stored unknown-shaped — the original generic narrowing has done its job
    // at the call site. `compile.ts` walks the config tree structurally.
    readonly config: unknown;
};

export function defineMode<
    TParentContext,
    TEvents extends { type: string },
    TCtx extends
        | CompoundContext<TParentContext, ReadonlyArray<keyof TParentContext & string>, object>
        | undefined,
    TStates extends StatesMap<LocalContextOf<TParentContext, TCtx>, TEvents>,
>(
    config: ModeConfig<TParentContext, TEvents, TCtx, TStates>,
): Mode<TParentContext, TEvents> {
    const carrier: ModeCarrier<TParentContext, TEvents> = {
        __kind: "compound",
        config,
    };
    return carrier as unknown as Mode<TParentContext, TEvents>;
}
