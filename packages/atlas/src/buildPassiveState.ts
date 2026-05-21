// Lower a passive `LeafModeConfig` to an XState atomic-state config.
// Spec: docs/specs/004-tasks.md Phase 5.4 + docs/specs/004-xstate-agent-wrapper.md §Mapping.
//
// Passive leaves carry only `on` handlers (no `behavior`, no actor). The
// mapping is structurally identity:
//   { on: { EVENT: { target, actions, guard } } } → same shape on XState.
// `actions` strings reference entries in `defineAgent.actions` (registered
// in `setup({ actions })` — that step lands in slice 5.5).
//
// `END` targets stay as the `END` symbol in the output; the compound-level
// `$end` substate injection + END→`$end` rewrite happens in slice 5.11
// before the final XState `createMachine` call.

import { liftGuard, type LiftContext } from "./contextLift.ts";
import type {
    EventTransition,
    PassiveLeafModeConfig,
    RouteTarget,
} from "./types.ts";

// Intermediate, XState-shaped transition. Loose typing on `context` / `event`
// — the wrapper does not see the user's concrete types at this layer;
// they were already enforced by the `defineLeafMode` call site.
export type LoweredTransition = {
    target?: RouteTarget;
    actions?: string | readonly string[];
    guard?: (args: { context: unknown; event: unknown }) => boolean;
};

export type LoweredAtomicState = {
    on: Record<string, LoweredTransition | readonly LoweredTransition[]>;
};

// `Array.isArray` narrows to `any[]`, which fails to subtract
// `readonly T[]` from a union like `T | readonly T[]`. This typed predicate
// gives TypeScript the narrowing it needs without leaking `any`.
function isReadonlyArray<T>(value: T | readonly T[]): value is readonly T[] {
    return Array.isArray(value);
}

function mapTransition(
    t: EventTransition<unknown, { type: string }>,
    lift: LiftContext | undefined,
): LoweredTransition {
    const out: LoweredTransition = {};
    if (t.target !== undefined) out.target = t.target;
    if (t.actions !== undefined) out.actions = t.actions;
    if (t.guard !== undefined) {
        // The user typed `guard` as `(args: { context, event }) => boolean`
        // with concrete C/E types. Widening to `unknown` is safe — XState
        // calls the function with the matching shape at runtime, and the
        // user code's narrowing is preserved as it was written.
        //
        // Under a compound-local context lift, route the call through
        // `liftGuard` so the user sees the virtual merged view (inherited
        // + local) — same view the type system promised.
        const userGuard = t.guard as (args: { context: unknown; event: unknown }) => boolean;
        out.guard = lift !== undefined ? liftGuard(userGuard, lift) : userGuard;
    }
    return out;
}

export function buildPassiveState(
    config: PassiveLeafModeConfig<unknown, { type: string }>,
    lift?: LiftContext,
): LoweredAtomicState {
    const on: LoweredAtomicState["on"] = {};
    for (const [eventType, transitions] of Object.entries(config.on)) {
        if (transitions === undefined) continue;
        on[eventType] = isReadonlyArray(transitions)
            ? transitions.map((t) => mapTransition(t, lift))
            : mapTransition(transitions, lift);
    }
    return { on };
}
