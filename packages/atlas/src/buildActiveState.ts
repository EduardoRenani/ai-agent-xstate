// Lower an active `Mode` (leaf) slot to an XState `{ invoke: { src, input, onDone, onError? } }`
// state. Spec: docs/specs/004-tasks.md Phase 5.6 + 5.7 + 5.9 +
// docs/specs/004-xstate-agent-wrapper.md §Mapping.
// Spec 005: every user callback envelope (input, behavior, routes.*.assign)
// is extended with the agent's frozen `deps` reference, captured here in
// each generated closure.
//
// Cardinality and order of `onDone[i]`:
//   - one entry per `routes.achieved` route entry, in order
//   - then one entry per `routes.retry` route entry, in order
//     (zero if `retry: readonly []`)
//   - then one entry per `routes.abandoned` route entry, in order
//
// Each `onDone[i]` carries:
//   - `target`:
//       achieved / abandoned → the entry's own `target` (END symbol stays;
//       slice 5.11 rewrites it to `$end`)
//       retry → the leaf's last-segment sibling name, with `reenter: true`
//       so XState re-fires the invoke
//   - `guard`: combines `event.output.outcome === "<key>"` with the user's
//     optional `when(payload)` — the entry only fires for the matching
//     outcome AND only when the user's payload-typed predicate agrees
//   - `actions`: the user's optional `assign` callback wrapped in XState's
//     `assign(...)`, with `event.output.payload` bridged into the `payload`
//     argument the user typed against, and `deps` threaded from the
//     closure that `buildActiveState` was called with
//
// `routes.error` → `invoke.onError[i]` with the same shape as onDone, except:
//   - guard sees `event.error` instead of `event.output.{outcome,payload}`
//   - target may be `RE_THROW` (a symbol); the actual re-throw action is
//     emitted in slice 5.10 — slice 5.9 leaves RE_THROW as-is in `target`.
// When `routes.error` is omitted, no `onError` field is emitted — XState's
// default (rejection halts the actor) matches the spec's "wrapper re-throws"
// guarantee.

import { assign } from "xstate";

import { actorName } from "./actorName.ts";
import {
    liftErrorAssign,
    liftExitAssign,
    liftInput,
    type LiftContext,
} from "./contextLift.ts";
import { END, RE_THROW } from "./types.ts";
import {
    END_ABANDONED,
    END_ACHIEVED,
    END_ERROR,
    type EndBucketSymbol,
} from "./endBuckets.ts";
import type {
    ErrorEntry,
    ErrorRouteTarget,
    ExitEntry,
    JsonObject,
    ModeOutput,
    Outcome,
    RetryEntry,
    RouteTarget,
    Routes,
} from "./types.ts";
import type { LeafSlot } from "./walk.ts";

// Internal pass-through placeholder for TContext at this layer. The user's
// concrete `TContext` has already been enforced by `defineMode`'s generic
// constraint; the build* helpers see only `unknown`-cast values and only need
// a JSON-shaped anchor so the alias references compile.
type InternalCtx = JsonObject;

// `Array.isArray` widens `readonly T[]` to `any[]` and does not subtract it
// from a `T | readonly T[]` union. A typed predicate fixes the narrowing
// without leaking `any`.
function isReadonlyArray<T>(value: T | readonly T[]): value is readonly T[] {
    return Array.isArray(value);
}

export type LoweredGuard = (args: {
    event: { output: ModeOutput<unknown> };
}) => boolean;

// `target` widens `RouteTarget` with `EndBucketSymbol` because `END` is
// replaced in-place with a bucket sentinel below (`bucketTarget`) so that
// `injectEnd` can later rewrite it to the correct `$end_<outcome>` state
// name. The sentinel never escapes `compile.ts` — it is rewritten before
// `createMachine` receives the lowered shape.
export type LoweredOnDoneTransition = {
    guard?: LoweredGuard;
    target?: RouteTarget | EndBucketSymbol | string;
    reenter?: boolean;
    actions?: ReturnType<typeof assign>;
};

export type LoweredErrorGuard = (args: {
    event: { error: unknown };
}) => boolean;

// onError actions are either:
//   - a wrapped `assign(...)` (when the user supplied `assign`), or
//   - a plain re-throw function (when `target: RE_THROW`).
export type LoweredReThrowAction = (args: {
    event: { error: unknown };
}) => never;

export type LoweredErrorAction = ReturnType<typeof assign> | LoweredReThrowAction;

export type LoweredOnErrorTransition = {
    guard?: LoweredErrorGuard;
    target?: ErrorRouteTarget | EndBucketSymbol | string;
    actions?: LoweredErrorAction;
};

export type LoweredInvokeState = {
    invoke: {
        src: string;
        input: (args: { context: unknown }) => unknown;
        onDone: readonly LoweredOnDoneTransition[];
        onError?: readonly LoweredOnErrorTransition[];
    };
};

function normalizeExitEntries(
    entry:
        | ExitEntry<InternalCtx, unknown>
        | readonly ExitEntry<InternalCtx, unknown>[],
): readonly ExitEntry<InternalCtx, unknown>[] {
    return isReadonlyArray(entry) ? entry : [entry];
}

function normalizeRetryEntries(
    entry:
        | RetryEntry<InternalCtx, unknown>
        | readonly RetryEntry<InternalCtx, unknown>[],
): readonly RetryEntry<InternalCtx, unknown>[] {
    return isReadonlyArray(entry) ? entry : [entry];
}

function normalizeErrorEntries(
    entry:
        | ErrorEntry<InternalCtx>
        | readonly ErrorEntry<InternalCtx>[],
): readonly ErrorEntry<InternalCtx>[] {
    return isReadonlyArray(entry) ? entry : [entry];
}

function makeGuard(
    outcomeKey: Outcome,
    userWhen: ((payload: unknown) => boolean) | undefined,
): LoweredGuard {
    return ({ event }) => {
        if (event.output.outcome !== outcomeKey) return false;
        if (userWhen === undefined) return true;
        return userWhen(event.output.payload);
    };
}

// Bridge `entry.assign({ context, payload, deps })` to XState's
// `assign(({ context, event }) => ...)`. The payload narrowing the user
// typed against is preserved through `event.output.payload`. The `deps`
// reference is captured from the closure that `buildActiveState` was
// called with — every emitted callback sees the same frozen object by
// identity.
//
// When a `lift` is in effect (the enclosing compound declared
// `context: { inherit, local }`), delegate to `liftExitAssign` instead:
// it presents the virtual `Pick<TParent, inherit[number]> & local` view to
// the user's callback and splits the returned partial back to the right
// destination (agent root vs. ancestor slot vs. own slot). `deps` is
// forwarded verbatim through the lift wrapper.
function wrapAssign(
    userAssign: (args: { context: unknown; payload: unknown; deps: Readonly<Record<string, unknown>> }) => object,
    lift: LiftContext | undefined,
    deps: Readonly<Record<string, unknown>>,
): ReturnType<typeof assign> {
    if (lift !== undefined) {
        return liftExitAssign(userAssign, lift, deps);
    }
    return assign(({ context, event }) => {
        const output = (event as unknown as { output: ModeOutput<unknown> }).output;
        return userAssign({ context, payload: output.payload, deps });
    });
}

// Map the user-visible `END` to the bucket-specific internal sentinel.
// Non-END targets pass through untouched. `injectEnd` later rewrites the
// sentinel to the matching `$end_<outcome>` state name at the enclosing
// compound's level.
function bucketTargetForExit(
    target: RouteTarget,
    outcomeKey: "achieved" | "abandoned",
): RouteTarget | EndBucketSymbol {
    if (target !== END) return target;
    return outcomeKey === "achieved" ? END_ACHIEVED : END_ABANDONED;
}

function buildExitTransition(
    outcomeKey: "achieved" | "abandoned",
    entry: ExitEntry<InternalCtx, unknown>,
    lift: LiftContext | undefined,
    deps: Readonly<Record<string, unknown>>,
): LoweredOnDoneTransition {
    const transition: LoweredOnDoneTransition = {
        guard: makeGuard(outcomeKey, entry.when),
        target: bucketTargetForExit(entry.target, outcomeKey),
    };
    if (entry.assign !== undefined) {
        transition.actions = wrapAssign(
            entry.assign as (args: { context: unknown; payload: unknown; deps: Readonly<Record<string, unknown>> }) => object,
            lift,
            deps,
        );
    }
    return transition;
}

function buildRetryTransition(
    selfSegment: string,
    entry: RetryEntry<InternalCtx, unknown>,
    lift: LiftContext | undefined,
    deps: Readonly<Record<string, unknown>>,
): LoweredOnDoneTransition {
    const transition: LoweredOnDoneTransition = {
        guard: makeGuard("retry", entry.when),
        target: selfSegment,
        reenter: true,
    };
    if (entry.assign !== undefined) {
        transition.actions = wrapAssign(
            entry.assign as (args: { context: unknown; payload: unknown; deps: Readonly<Record<string, unknown>> }) => object,
            lift,
            deps,
        );
    }
    return transition;
}

function makeErrorGuard(
    userWhen: ((error: unknown) => boolean) | undefined,
): LoweredErrorGuard {
    return ({ event }) => {
        if (userWhen === undefined) return true;
        return userWhen(event.error);
    };
}

function wrapErrorAssign(
    userAssign: (args: { context: unknown; error: unknown; deps: Readonly<Record<string, unknown>> }) => object,
    lift: LiftContext | undefined,
    deps: Readonly<Record<string, unknown>>,
): ReturnType<typeof assign> {
    if (lift !== undefined) {
        return liftErrorAssign(userAssign, lift, deps);
    }
    return assign(({ context, event }) => {
        const error = (event as unknown as { error: unknown }).error;
        return userAssign({ context, error, deps });
    });
}

// Re-throw action emitted for `target: RE_THROW` entries. Throwing inside an
// XState v5 action causes the invoking actor to surface the error, which
// propagates above the leaf — matching the spec's RE_THROW semantics. The
// transition itself carries no `target`; the re-throw IS the side effect.
function makeReThrowAction(): LoweredReThrowAction {
    return ({ event }) => {
        throw event.error;
    };
}

function buildErrorTransition(
    entry: ErrorEntry<InternalCtx>,
    lift: LiftContext | undefined,
    deps: Readonly<Record<string, unknown>>,
): LoweredOnErrorTransition {
    const guard = makeErrorGuard(entry.when);

    if (entry.target === RE_THROW) {
        // Spec line 833: `assign` on a RE_THROW entry is dropped at compile
        // time. The dispatch walk treats RE_THROW as terminal — XState's
        // first-match-wins ordering plus the thrown rejection naturally
        // prevent any later entry from running.
        return {
            guard,
            actions: makeReThrowAction(),
        };
    }

    // `END` in `routes.error` → `END_ERROR` bucket sentinel. RE_THROW was
    // already handled above; everything else is a sibling name.
    const errTarget: ErrorRouteTarget | EndBucketSymbol =
        entry.target === END ? END_ERROR : entry.target;
    const transition: LoweredOnErrorTransition = {
        guard,
        target: errTarget,
    };
    if (entry.assign !== undefined) {
        transition.actions = wrapErrorAssign(
            entry.assign as (args: { context: unknown; error: unknown; deps: Readonly<Record<string, unknown>> }) => object,
            lift,
            deps,
        );
    }
    return transition;
}

export function buildActiveState(
    slot: LeafSlot,
    lift: LiftContext | undefined,
    deps: Readonly<Record<string, unknown>>,
): LoweredInvokeState {
    const config = slot.config;
    if (!("behavior" in config)) {
        throw new Error(
            `atlas/buildActiveState: leaf at "${slot.path}" is passive — use buildPassiveState`,
        );
    }
    const routes = config.routes as Routes<InternalCtx, unknown>;

    const segments = slot.path.split(".");
    const selfSegment = segments[segments.length - 1];
    if (selfSegment === undefined || selfSegment === "") {
        throw new Error(`atlas/buildActiveState: malformed leaf path "${slot.path}"`);
    }

    const onDone: LoweredOnDoneTransition[] = [];

    for (const entry of normalizeExitEntries(routes.achieved)) {
        onDone.push(buildExitTransition("achieved", entry, lift, deps));
    }
    for (const entry of normalizeRetryEntries(routes.retry)) {
        onDone.push(buildRetryTransition(selfSegment, entry, lift, deps));
    }
    for (const entry of normalizeExitEntries(routes.abandoned)) {
        onDone.push(buildExitTransition("abandoned", entry, lift, deps));
    }

    // The user's `input` callback gains a `deps` parameter; wrap it so the
    // XState-facing input fn matches the existing `({ context }) => unknown`
    // shape while injecting `deps` from the closure.
    const userInput = config.input as (args: { context: unknown; deps: Readonly<Record<string, unknown>> }) => unknown;
    const wrappedInput: (args: { context: unknown }) => unknown =
        lift !== undefined
            ? liftInput(userInput, lift, deps)
            : ({ context }) => userInput({ context, deps });

    const invoke: LoweredInvokeState["invoke"] = {
        src: actorName(slot.path),
        input: wrappedInput,
        onDone,
    };

    if (routes.error !== undefined) {
        const onError: LoweredOnErrorTransition[] = [];
        for (const entry of normalizeErrorEntries(routes.error)) {
            onError.push(buildErrorTransition(entry, lift, deps));
        }
        invoke.onError = onError;
    }

    return { invoke };
}
