// `defineLeafMode` — constructs a leaf agent mode (active or passive variant).
//
// Spec: docs/specs/004-xstate-agent-wrapper.md §`defineLeafMode` + §Type contract.
//
// Phase 3 (these constructors) is a thin shell: it stores the user's config
// plus a runtime `__kind` tag behind the opaque `LeafMode` brand. The actual
// XState lowering happens in `compile.ts` (Phase 5) and is reached only via
// `defineAgent`. Users never inspect the returned object.

import type { LeafMode, LeafModeConfig } from "./types.ts";

// The runtime carrier behind the `LeafMode` brand. Not exported — accessed
// only by `compile.ts` via the well-known property name. Keeping the field
// non-symbol keeps `compile.ts` free of cross-module symbol imports.
export type LeafModeCarrier<TContext, TEvents extends { type: string }, TPayload> = {
    readonly __kind: "leaf";
    readonly config: LeafModeConfig<TContext, TEvents, TPayload>;
};

export function defineLeafMode<
    TContext,
    TEvents extends { type: string },
    TPayload = unknown,
>(
    config: LeafModeConfig<TContext, TEvents, TPayload>,
): LeafMode<TContext, TEvents, TPayload> {
    const carrier: LeafModeCarrier<TContext, TEvents, TPayload> = {
        __kind: "leaf",
        config,
    };
    // The brand is a phantom — at runtime the object is just the carrier.
    // The cast is the single boundary where the opaque type is minted; user
    // code can only obtain `LeafMode` values through this function.
    return carrier as unknown as LeafMode<TContext, TEvents, TPayload>;
}
