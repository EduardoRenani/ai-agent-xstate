// Lower a passive `ModeConfig` to an XState atomic-state config.
// Spec: docs/specs/004-tasks.md Phase 5.4 + docs/specs/004-xstate-agent-wrapper.md §Mapping.
// Spec 005: `on[*].guard` gains a `deps` parameter; the wrapper captures the
// agent's frozen `deps` reference in the generated guard's closure.
//
// Passive leaves carry only `on` handlers (no `behavior`, no actor). The
// mapping is structurally identity for `target` / `actions`:
//   { on: { EVENT: { target, actions, guard } } } → same shape on XState.
// `actions` strings reference entries in `defineAgent.actions` (registered
// in `setup({ actions })` — those already close over `deps`).
//
// `END` targets stay as the `END` symbol in the output; the compound-level
// `$end` substate injection + END→`$end` rewrite happens in slice 5.11
// before the final XState `createMachine` call.

import { liftGuard, type LiftContext } from "./contextLift.ts";
import { END_ACHIEVED, type EndBucketSymbol } from "./endBuckets.ts";
import { END } from "./types.ts";
import type {
    EventTransition,
    JsonObject,
    PassiveModeConfig,
    RouteTarget,
} from "./types.ts";

// Internal pass-through placeholder for TContext at this layer (see
// buildActiveState.ts for the same alias).
type InternalCtx = JsonObject;

// Intermediate, XState-shaped transition. Loose typing on `context` / `event`
// — the wrapper does not see the user's concrete types at this layer;
// they were already enforced by the `defineMode` call site. `target` widens
// to include `EndBucketSymbol` because passive `target: END` is replaced
// in-place with `END_ACHIEVED` (spec 008 — passive END defaults to the
// achieved bucket); `injectEnd` rewrites the sentinel to the matching
// `$end_achieved` state name at the enclosing compound's level.
export type LoweredTransition = {
    target?: RouteTarget | EndBucketSymbol | string;
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
    t: EventTransition<InternalCtx, { type: string }>,
    lift: LiftContext | undefined,
    deps: Readonly<Record<string, unknown>>,
): LoweredTransition {
    const out: LoweredTransition = {};
    if (t.target !== undefined) {
        // Passive `target: END` defaults to bubbling `achieved` (spec 008
        // §"Outcome propagation rules"). Non-END targets pass through.
        out.target = t.target === END ? END_ACHIEVED : t.target;
    }
    if (t.actions !== undefined) out.actions = t.actions;
    if (t.guard !== undefined) {
        // The user typed `guard` as `({ context, event, deps }) => boolean`
        // with concrete C/E types. Widening to `unknown` is safe — XState
        // calls the function with the matching shape at runtime, and the
        // user code's narrowing is preserved as it was written.
        //
        // Under a compound-local context lift, route the call through
        // `liftGuard` so the user sees the virtual merged view (inherited
        // + local) — same view the type system promised. `deps` is
        // forwarded verbatim regardless of lift.
        const userGuard = t.guard as (args: {
            context: unknown;
            event: unknown;
            deps: Readonly<Record<string, unknown>>;
        }) => boolean;
        if (lift !== undefined) {
            out.guard = liftGuard(userGuard, lift, deps);
        } else {
            out.guard = ({ context, event }) => userGuard({ context, event, deps });
        }
    }
    return out;
}

export function buildPassiveState(
    config: PassiveModeConfig<InternalCtx, { type: string }>,
    lift: LiftContext | undefined,
    deps: Readonly<Record<string, unknown>>,
): LoweredAtomicState {
    const on: LoweredAtomicState["on"] = {};
    for (const [eventType, transitions] of Object.entries(config.on)) {
        if (transitions === undefined) continue;
        on[eventType] = isReadonlyArray(transitions)
            ? transitions.map((t) => mapTransition(t, lift, deps))
            : mapTransition(transitions, lift, deps);
    }
    return { on };
}
