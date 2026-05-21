// Lower an active `LeafMode` slot to an XState `{ invoke: { src, input, onDone, onError? } }`
// state. Spec: docs/specs/004-tasks.md Phase 5.6 + 5.7 + 5.9 +
// docs/specs/004-xstate-agent-wrapper.md §Mapping.
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
//     argument the user typed against
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
import { RE_THROW } from "./types.ts";
import type {
    ErrorEntry,
    ErrorRouteTarget,
    ExitEntry,
    ModeOutput,
    Outcome,
    RetryEntry,
    RouteTarget,
    Routes,
} from "./types.ts";
import type { LeafSlot } from "./walk.ts";

// `Array.isArray` widens `readonly T[]` to `any[]` and does not subtract it
// from a `T | readonly T[]` union. A typed predicate fixes the narrowing
// without leaking `any`.
function isReadonlyArray<T>(value: T | readonly T[]): value is readonly T[] {
    return Array.isArray(value);
}

export type LoweredGuard = (args: {
    event: { output: ModeOutput<unknown> };
}) => boolean;

export type LoweredOnDoneTransition = {
    guard?: LoweredGuard;
    target?: RouteTarget;
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
    target?: ErrorRouteTarget;
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
        | ExitEntry<unknown, unknown>
        | readonly ExitEntry<unknown, unknown>[],
): readonly ExitEntry<unknown, unknown>[] {
    return isReadonlyArray(entry) ? entry : [entry];
}

function normalizeRetryEntries(
    entry:
        | RetryEntry<unknown, unknown>
        | readonly RetryEntry<unknown, unknown>[],
): readonly RetryEntry<unknown, unknown>[] {
    return isReadonlyArray(entry) ? entry : [entry];
}

function normalizeErrorEntries(
    entry:
        | ErrorEntry<unknown>
        | readonly ErrorEntry<unknown>[],
): readonly ErrorEntry<unknown>[] {
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

// Bridge `entry.assign({ context, payload })` to XState's
// `assign(({ context, event }) => ...)`. The payload narrowing the user
// typed against is preserved through `event.output.payload`.
//
// When a `lift` is in effect (the enclosing compound declared
// `context: { inherit, local }`), delegate to `liftExitAssign` instead:
// it presents the virtual `Pick<TParent, inherit[number]> & local` view to
// the user's callback and splits the returned partial back to the right
// destination (agent root vs. ancestor slot vs. own slot).
function wrapAssign(
    userAssign: (args: { context: unknown; payload: unknown }) => object,
    lift: LiftContext | undefined,
): ReturnType<typeof assign> {
    if (lift !== undefined) {
        return liftExitAssign(userAssign, lift);
    }
    return assign(({ context, event }) => {
        const output = (event as unknown as { output: ModeOutput<unknown> }).output;
        return userAssign({ context, payload: output.payload });
    });
}

function buildExitTransition(
    outcomeKey: "achieved" | "abandoned",
    entry: ExitEntry<unknown, unknown>,
    lift: LiftContext | undefined,
): LoweredOnDoneTransition {
    const transition: LoweredOnDoneTransition = {
        guard: makeGuard(outcomeKey, entry.when),
        target: entry.target,
    };
    if (entry.assign !== undefined) {
        transition.actions = wrapAssign(entry.assign, lift);
    }
    return transition;
}

function buildRetryTransition(
    selfSegment: string,
    entry: RetryEntry<unknown, unknown>,
    lift: LiftContext | undefined,
): LoweredOnDoneTransition {
    const transition: LoweredOnDoneTransition = {
        guard: makeGuard("retry", entry.when),
        target: selfSegment,
        reenter: true,
    };
    if (entry.assign !== undefined) {
        transition.actions = wrapAssign(entry.assign, lift);
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
    userAssign: (args: { context: unknown; error: unknown }) => object,
    lift: LiftContext | undefined,
): ReturnType<typeof assign> {
    if (lift !== undefined) {
        return liftErrorAssign(userAssign, lift);
    }
    return assign(({ context, event }) => {
        const error = (event as unknown as { error: unknown }).error;
        return userAssign({ context, error });
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
    entry: ErrorEntry<unknown>,
    lift: LiftContext | undefined,
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

    const transition: LoweredOnErrorTransition = {
        guard,
        target: entry.target,
    };
    if (entry.assign !== undefined) {
        transition.actions = wrapErrorAssign(entry.assign, lift);
    }
    return transition;
}

export function buildActiveState(
    slot: LeafSlot,
    lift?: LiftContext,
): LoweredInvokeState {
    const config = slot.config;
    if (!("behavior" in config)) {
        throw new Error(
            `atlas/buildActiveState: leaf at "${slot.path}" is passive — use buildPassiveState`,
        );
    }
    const routes = config.routes as Routes<unknown, unknown>;

    const segments = slot.path.split(".");
    const selfSegment = segments[segments.length - 1];
    if (selfSegment === undefined || selfSegment === "") {
        throw new Error(`atlas/buildActiveState: malformed leaf path "${slot.path}"`);
    }

    const onDone: LoweredOnDoneTransition[] = [];

    for (const entry of normalizeExitEntries(routes.achieved)) {
        onDone.push(buildExitTransition("achieved", entry, lift));
    }
    for (const entry of normalizeRetryEntries(routes.retry)) {
        onDone.push(buildRetryTransition(selfSegment, entry, lift));
    }
    for (const entry of normalizeExitEntries(routes.abandoned)) {
        onDone.push(buildExitTransition("abandoned", entry, lift));
    }

    const userInput = config.input as (args: { context: unknown }) => unknown;
    const invoke: LoweredInvokeState["invoke"] = {
        src: actorName(slot.path),
        input: lift !== undefined ? liftInput(userInput, lift) : userInput,
        onDone,
    };

    if (routes.error !== undefined) {
        const onError: LoweredOnErrorTransition[] = [];
        for (const entry of normalizeErrorEntries(routes.error)) {
            onError.push(buildErrorTransition(entry, lift));
        }
        invoke.onError = onError;
    }

    return { invoke };
}
