// Lower a unified `Mode` (leaf) to an XState **mini-compound**.
//
// Spec: docs/specs/011-self-suspending-modes.md §Desugaring (DD-029 — "a mode
//        is a mini-compound") + §The model + §Surface.
//        (supersedes the active-only `{ invoke }` leaf from spec 004.)
// Spec 005: every user callback envelope (input, behavior, routes.*.assign,
// stay.*.assign) is extended with the agent's frozen `deps` reference, captured
// in each generated closure.
//
// SPEC 011 §Desugaring: a self-suspending mode lowers to a compound state with
// two synthetic substates (`$run`, `$wait`), reusing the existing compound +
// `injectEnd` pipeline:
//
//   foo: {
//       initial: "$run" (active) | "$wait" (passive),
//       states: {
//           $run: { invoke: { src, input, onDone, onError? } },
//           $wait: { on: { <events>: { target: "$run", actions: <save event>, reenter: true } } },
//           $end_achieved / $end_abandoned / $end_error  ← injected here (LOCAL)
//       },
//       onDone: [ achieved → route target, abandoned → route target, error? ],
//   }
//
// `$run.invoke.onDone[i]`:
//   - `outcome: achieved/abandoned` → END bucket sentinel; the LOCAL injection
//     below rewrites it to a `$end_<bucket>` final, and `foo.onDone` routes to
//     the sibling — identical to a compound today.
//   - `stay: replay`  → `{ target: "$run", reenter: true }` (the old retry
//     self-loop, DD-014). active CLEARS the `$event` slot; passive KEEPS it.
//   - `stay: waitOnEvent` → `{ target: "$wait" }`.
//
// `routes.error` → `$run.invoke.onError[i]` (END_ERROR bucket sentinel /
// RE_THROW), unchanged in shape from spec 010.

import { assign } from "xstate";

import { actorName } from "./actorName.ts";
import { liftExitAssign, liftInput, type LiftContext } from "./contextLift.ts";
import {
    END_ABANDONED,
    END_ACHIEVED,
    END_ERROR,
    bucketOf,
    isBucketSymbol,
    type EndBucket,
    type EndBucketSymbol,
} from "./endBuckets.ts";
import { EVENT_SLOT } from "./eventSlot.ts";
import {
    makeLeafExitFinalSubstate,
    pickEndName,
    type LoweredFinalState,
} from "./injectEnd.ts";
import { END, RE_THROW } from "./types.ts";
import type {
    CommonModeConfig,
    ErrorEntry,
    ErrorRouteTarget,
    ExitEntry,
    JsonObject,
    ModeConfig,
    Outcome,
    RouteTarget,
    StayEntry,
    StayMap,
} from "./types.ts";
import type { LeafSlot } from "./walk.ts";

// Internal pass-through placeholder for TContext at this layer. The user's
// concrete `TContext` has already been enforced by `defineMode`'s generic
// constraint; the build* helpers see only `unknown`-cast values and only need
// a JSON-shaped anchor so the alias references compile.
type InternalCtx = JsonObject;

type UserExitAssign = (args: {
    context: unknown;
    payload: unknown;
    deps: Readonly<Record<string, unknown>>;
}) => object;

type UserErrorAssign = (args: {
    context: unknown;
    error: unknown;
    deps: Readonly<Record<string, unknown>>;
}) => object;

// `Array.isArray` widens `readonly T[]` to `any[]` and does not subtract it
// from a `T | readonly T[]` union. A typed predicate fixes the narrowing
// without leaking `any`.
function isReadonlyArray<T>(value: T | readonly T[]): value is readonly T[] {
    return Array.isArray(value);
}

// SPEC 011 §Desugaring: the actor's done event carries the behavior's
// `ModeResult` in `event.output` — `{ outcome }` (LEAVE) XOR `{ stay }`
// (STAY), both with `payload`.
type ModeResultEvent = {
    output: {
        outcome?: Outcome;
        stay?: "replay" | "waitOnEvent";
        payload: unknown;
    };
};

export type LoweredGuard = (args: { event: ModeResultEvent }) => boolean;

type LoweredActions = ReturnType<typeof assign> | readonly ReturnType<typeof assign>[];

// `target` widens `RouteTarget` with `EndBucketSymbol` because `END` is
// replaced in-place with a bucket sentinel so that the LOCAL injection can
// rewrite it to the correct `$end_<outcome>` substate name. The sentinel never
// escapes this module — it is rewritten before the mini-compound is returned.
export type LoweredOnDoneTransition = {
    guard?: LoweredGuard;
    target?: RouteTarget | EndBucketSymbol | string;
    reenter?: boolean;
    actions?: LoweredActions;
};

export type LoweredErrorGuard = (args: { event: { error: unknown } }) => boolean;

// onError actions are either:
//   - a wrapped `assign(...)` (when the user supplied `assign`), or
//   - a plain re-throw function (when `target: RE_THROW`).
export type LoweredReThrowAction = (args: { event: { error: unknown } }) => never;

export type LoweredErrorAction = ReturnType<typeof assign> | LoweredReThrowAction;

export type LoweredOnErrorTransition = {
    guard?: LoweredErrorGuard;
    target?: ErrorRouteTarget | EndBucketSymbol | string;
    actions?: LoweredErrorAction;
};

// The `$run` substate: invokes the behavior. `input` reads the waking event
// from the `$event` slot and passes it alongside the user's derived input.
export type LoweredInvokeState = {
    invoke: {
        src: string;
        input: (args: { context: unknown }) => unknown;
        onDone: readonly LoweredOnDoneTransition[];
        onError?: readonly LoweredOnErrorTransition[];
    };
};

export type LoweredWaitTransition = {
    target: string;
    actions: ReturnType<typeof assign>;
    reenter: true;
};

// The `$wait` substate: parks until a declared event arrives, saves it to the
// `$event` slot, and re-enters `$run`.
//
// SPEC 011 Clarification #6: the waited-on event types are also stamped onto the
// state's `meta` (`atlasAwaiting`). XState v5 snapshots don't expose
// `nextEvents`, so `meta` is the robust way for the inspect adapter to recover
// readiness from the active leaf and surface it as `AgentInspectionEvent.awaiting`.
export type LoweredWaitMeta = {
    atlasAwaiting: readonly string[];
};

export type LoweredWaitState = {
    on: Record<string, LoweredWaitTransition>;
    meta?: LoweredWaitMeta;
};

// SPEC 011 §Desugaring: a mode lowers to a compound XState state with `$run`,
// `$wait`, and injected `$end_*` finals. Externally `foo` IS the mode — entry
// is via its `initial`, siblings target `foo`, and `foo.onDone` routes the
// behavior's outcome to the sibling.
export type LoweredModeCompound = {
    initial: string;
    // SPEC 011: clear the `$event` slot on every DIRECT entry into the mode, so a
    // dry run never sees the previous mode's event. The internal `$wait → $run`
    // transition (which saves the event) does not re-enter the compound, so the
    // saved event survives for the behavior.
    entry?: ReturnType<typeof assign>;
    states: Record<string, LoweredInvokeState | LoweredWaitState | LoweredFinalState>;
    onDone: readonly LoweredOnDoneTransition[];
};

function normalizeExitEntries(
    entry:
        | ExitEntry<InternalCtx, unknown>
        | readonly ExitEntry<InternalCtx, unknown>[],
): readonly ExitEntry<InternalCtx, unknown>[] {
    return isReadonlyArray(entry) ? entry : [entry];
}

function normalizeErrorEntries(
    entry: ErrorEntry<InternalCtx> | readonly ErrorEntry<InternalCtx>[],
): readonly ErrorEntry<InternalCtx>[] {
    return isReadonlyArray(entry) ? entry : [entry];
}

// ── $run.invoke.input ────────────────────────────────────────────────

// SPEC 011 §Desugaring: `$run.invoke.input` reads the waking event from the
// `$event` slot and passes it to the behavior alongside the user's derived
// `userInput`: `{ userInput, event: context[$event] }`.
function buildRunInput(
    userInput: (args: {
        context: unknown;
        deps: Readonly<Record<string, unknown>>;
    }) => unknown,
    lift: LiftContext | undefined,
    deps: Readonly<Record<string, unknown>>,
): (args: { context: unknown }) => unknown {
    const liftedUserInput: (args: { context: unknown }) => unknown =
        lift !== undefined
            ? liftInput(userInput, lift, deps)
            : ({ context }) => userInput({ context, deps });

    return ({ context }) => {
        const root = context as Record<string, unknown>;
        const event = root[EVENT_SLOT];
        return { userInput: liftedUserInput({ context }), event };
    };
}

// ── $run.invoke.onDone: stay continuations ───────────────────────────

// SPEC 011 §The model: a continuation fires when `behavior` returns
// `{ stay: "replay" | "waitOnEvent" }`. Dispatch on `event.output.stay`.
function makeStayGuard(stayKey: "replay" | "waitOnEvent"): LoweredGuard {
    return ({ event }) => event.output.stay === stayKey;
}

// SPEC 011: `assign` is uniform — exits and continuations use the same
// `({ context, payload, deps }) => Partial<Ctx>` shape, fed `event.output.payload`.
function wrapStayAssign(
    userAssign: UserExitAssign,
    lift: LiftContext | undefined,
    deps: Readonly<Record<string, unknown>>,
): ReturnType<typeof assign> {
    if (lift !== undefined) {
        return liftExitAssign(userAssign, lift, deps);
    }
    return assign(({ context, event }) => {
        const output = (event as unknown as { output: { payload: unknown } }).output;
        return userAssign({ context, payload: output.payload, deps });
    });
}

// Root-level action that clears the `$event` slot (`event => undefined`).
function clearEventSlotAction(): ReturnType<typeof assign> {
    return assign({ [EVENT_SLOT]: () => undefined });
}

function buildStayReplayTransition(
    startsRunning: boolean,
    entry: StayEntry<InternalCtx, unknown>,
    lift: LiftContext | undefined,
    deps: Readonly<Record<string, unknown>>,
): LoweredOnDoneTransition {
    // SPEC 011 §Desugaring: `stay:"replay"` → `{ target: "$run", reenter: true }`;
    // **active** clears the `$event` slot (no event), **passive** keeps it
    // (same event). The optional user `assign` runs before the re-run.
    const transition: LoweredOnDoneTransition = {
        guard: makeStayGuard("replay"),
        target: "$run",
        reenter: true,
    };

    const userAssign = entry.assign as UserExitAssign | undefined;
    const actions: ReturnType<typeof assign>[] = [];
    // active CLEARS the slot; passive KEEPS it. The slot lives in root context,
    // so it is a separate root-level `assign` composed with the (possibly
    // lift-split) user assign.
    if (startsRunning) actions.push(clearEventSlotAction());
    if (userAssign !== undefined) actions.push(wrapStayAssign(userAssign, lift, deps));

    if (actions.length === 1) transition.actions = actions[0];
    else if (actions.length > 1) transition.actions = actions;
    return transition;
}

function buildStayWaitTransition(
    entry: StayEntry<InternalCtx, unknown>,
    lift: LiftContext | undefined,
    deps: Readonly<Record<string, unknown>>,
): LoweredOnDoneTransition {
    // SPEC 011 §Desugaring: `stay:"waitOnEvent"` → `{ target: "$wait" }`. The
    // slot is NOT touched here — `$wait` overwrites it with the next event.
    const transition: LoweredOnDoneTransition = {
        guard: makeStayGuard("waitOnEvent"),
        target: "$wait",
    };
    const userAssign = entry.assign as UserExitAssign | undefined;
    if (userAssign !== undefined) {
        transition.actions = wrapStayAssign(userAssign, lift, deps);
    }
    return transition;
}

// ── $run.invoke.onDone: achieved / abandoned exits → local $end_* ────

// SPEC 011 §Desugaring: an exit → `$run.invoke.onDone[i]` targeting the END
// bucket sentinel; the LOCAL injection rewrites it to a `$end_<bucket>` final
// that forwards the behavior's payload, and `foo.onDone` routes to the sibling.
//
// The exit `target`/`assign` belong to `foo.onDone` (parent scope); `$run`
// only decides WHICH outcome bucket fired, so the guard here is outcome-only
// (payload guards run on `foo.onDone`).
function makeOutcomeGuard(outcomeKey: Outcome): LoweredGuard {
    return ({ event }) => event.output.outcome === outcomeKey;
}

function buildExitOnDone(outcomeKey: "achieved" | "abandoned"): LoweredOnDoneTransition {
    return {
        guard: makeOutcomeGuard(outcomeKey),
        target: outcomeKey === "achieved" ? END_ACHIEVED : END_ABANDONED,
    };
}

// ── $run.invoke.onError ──────────────────────────────────────────────

function makeErrorGuard(
    userWhen: ((error: unknown) => boolean) | undefined,
): LoweredErrorGuard {
    return ({ event }) => {
        if (userWhen === undefined) return true;
        return userWhen(event.error);
    };
}

function makeReThrowAction(): LoweredReThrowAction {
    return ({ event }) => {
        throw event.error;
    };
}

function buildErrorTransition(entry: ErrorEntry<InternalCtx>): LoweredOnErrorTransition {
    const guard = makeErrorGuard(entry.when);

    if (entry.target === RE_THROW) {
        // Spec 010: `assign` on a RE_THROW entry is dropped; the re-throw IS
        // the side effect.
        return { guard, actions: makeReThrowAction() };
    }

    // Any non-RE_THROW error entry routes through the mode's `$end_error`
    // final (carrying the raw error as payload); `foo.onDone`'s error entry
    // then applies the user's `target`/`assign`. So `$run.invoke.onError`
    // always targets the local `$end_error` bucket.
    return { guard, target: END_ERROR };
}

// ── $wait substate ───────────────────────────────────────────────────

// SPEC 011 §Desugaring: `$wait` receives a declared event → an action saves it
// to the `$event` slot and re-enters `$run`.
function buildWaitState(events: readonly string[]): LoweredWaitState {
    const on: LoweredWaitState["on"] = {};
    for (const eventType of events) {
        on[eventType] = {
            target: "$run",
            actions: assign(({ event }) => ({ [EVENT_SLOT]: event })),
            reenter: true,
        };
    }
    // SPEC 011 Clarification #6: stamp the waited-on event types onto `meta`
    // (`atlasAwaiting`) so the inspect adapter can recover readiness from a
    // parked leaf's active state and report it via `AgentInspectionEvent.awaiting`.
    return { on, meta: { atlasAwaiting: events } };
}

// ── foo.onDone (mode `routes` → compound-style onDone) ───────────────

// `foo.onDone` dispatches against the `{ outcome, payload }` the local `$end_*`
// finals emit (same shape a real compound dispatches against). Guard on
// `event.output.outcome`; `payload` is the behavior's payload forwarded by the
// leaf final.
function makeFooOutcomeGuard(
    outcomeKey: EndBucket,
    userWhen: ((payload: unknown) => boolean) | undefined,
): (args: { event: unknown }) => boolean {
    return ({ event }) => {
        const out = (event as { output?: { outcome?: unknown; payload?: unknown } }).output;
        if (out === undefined) return false;
        if (out.outcome !== outcomeKey) return false;
        if (userWhen === undefined) return true;
        return userWhen(out.payload);
    };
}

function wrapFooExitAssign(
    userAssign: UserExitAssign,
    lift: LiftContext | undefined,
    deps: Readonly<Record<string, unknown>>,
): ReturnType<typeof assign> {
    if (lift !== undefined) {
        return liftExitAssign(userAssign, lift, deps);
    }
    return assign(({ context, event }) => {
        const output = (event as unknown as { output: { payload: unknown } }).output;
        return userAssign({ context, payload: output.payload, deps });
    });
}

function wrapFooErrorAssign(
    userAssign: UserErrorAssign,
    deps: Readonly<Record<string, unknown>>,
): ReturnType<typeof assign> {
    return assign(({ context, event }) => {
        const error = (event as unknown as { output: { payload: unknown } }).output.payload;
        return userAssign({ context, error, deps });
    });
}

function buildFooExitTransition(
    outcomeKey: "achieved" | "abandoned",
    entry: ExitEntry<InternalCtx, unknown>,
    lift: LiftContext | undefined,
    deps: Readonly<Record<string, unknown>>,
): LoweredOnDoneTransition {
    const transition: LoweredOnDoneTransition = {
        guard: makeFooOutcomeGuard(outcomeKey, entry.when),
        target:
            entry.target === END
                ? outcomeKey === "achieved"
                    ? END_ACHIEVED
                    : END_ABANDONED
                : entry.target,
    };
    if (entry.assign !== undefined) {
        transition.actions = wrapFooExitAssign(entry.assign as UserExitAssign, lift, deps);
    }
    return transition;
}

function buildFooErrorTransition(
    entry: ErrorEntry<InternalCtx>,
    deps: Readonly<Record<string, unknown>>,
): LoweredOnDoneTransition {
    const guard = makeFooOutcomeGuard("error", entry.when);

    if (entry.target === RE_THROW) {
        return {
            guard,
            actions: assign(({ event }) => {
                throw (event as unknown as { output: { payload: unknown } }).output.payload;
            }),
        };
    }

    const transition: LoweredOnDoneTransition = {
        guard,
        target: entry.target === END ? END_ERROR : entry.target,
    };
    if (entry.assign !== undefined) {
        transition.actions = wrapFooErrorAssign(entry.assign as UserErrorAssign, deps);
    }
    return transition;
}

function buildModeOnDone(
    routes: CommonModeConfig<InternalCtx, { type: string }, unknown>["routes"],
    lift: LiftContext | undefined,
    deps: Readonly<Record<string, unknown>>,
): readonly LoweredOnDoneTransition[] {
    const out: LoweredOnDoneTransition[] = [];
    for (const entry of normalizeExitEntries(routes.achieved)) {
        out.push(buildFooExitTransition("achieved", entry, lift, deps));
    }
    for (const entry of normalizeExitEntries(routes.abandoned)) {
        out.push(buildFooExitTransition("abandoned", entry, lift, deps));
    }
    if (routes.error !== undefined) {
        for (const entry of normalizeErrorEntries(routes.error)) {
            out.push(buildFooErrorTransition(entry, deps));
        }
    }
    return out;
}

// ── Public entry: lower a leaf mode to a mini-compound ────────────────

export function buildActiveState(
    slot: LeafSlot,
    lift: LiftContext | undefined,
    deps: Readonly<Record<string, unknown>>,
): LoweredModeCompound {
    const config: ModeConfig<InternalCtx, { type: string }, unknown> = slot.config;
    if (!("behavior" in config)) {
        throw new Error(`atlas/buildActiveState: leaf at "${slot.path}" has no behavior`);
    }
    const common = config as CommonModeConfig<InternalCtx, { type: string }, unknown>;
    const routes = common.routes;
    const stay: StayMap<InternalCtx, unknown> | undefined = common.stay;
    const events: readonly string[] = common.events ?? [];

    // SPEC 011 §The model: `start:"event"` → parks on entry (`initial:"$wait"`);
    // `start:"run"` (default) → runs the behavior immediately (`initial:"$run"`).
    const startsRunning = config.start !== "event";

    // ── $run.invoke.onDone ─────────────────────────────────────────
    const onDone: LoweredOnDoneTransition[] = [];

    // SPEC 011: exits — one outcome-only guard per LEAVE bucket → local final.
    onDone.push(buildExitOnDone("achieved"));
    onDone.push(buildExitOnDone("abandoned"));

    // SPEC 011: continuations — stay.replay → `$run` self-loop;
    // stay.waitOnEvent → `$wait`.
    if (stay?.replay !== undefined) {
        onDone.push(buildStayReplayTransition(startsRunning, stay.replay, lift, deps));
    }
    if (stay?.waitOnEvent !== undefined) {
        onDone.push(buildStayWaitTransition(stay.waitOnEvent, lift, deps));
    }

    // ── $run.invoke ────────────────────────────────────────────────
    const userInput = common.input as (args: {
        context: unknown;
        deps: Readonly<Record<string, unknown>>;
    }) => unknown;

    const invoke: LoweredInvokeState["invoke"] = {
        src: actorName(slot.path),
        input: buildRunInput(userInput, lift, deps),
        onDone,
    };

    // SPEC 010 / 011: `routes.error` → `$run.invoke.onError`.
    if (routes.error !== undefined) {
        const onError: LoweredOnErrorTransition[] = [];
        for (const entry of normalizeErrorEntries(routes.error)) {
            onError.push(buildErrorTransition(entry));
        }
        invoke.onError = onError;
    }

    const runState: LoweredInvokeState = { invoke };

    // ── states map (+ LOCAL $end_* injection) ──────────────────────
    const states: LoweredModeCompound["states"] = {
        $run: runState,
        $wait: buildWaitState(events),
    };

    // SPEC 011 §Desugaring: inject the `$end_<bucket>` finals referenced by
    // `$run.invoke.onDone`/`onError` LOCALLY (the mode's own mini-compound),
    // forwarding the behavior's payload to `foo.onDone`.
    const usedBuckets = new Set<EndBucketSymbol>();
    for (const t of onDone) {
        if (isBucketSymbol(t.target)) usedBuckets.add(t.target);
    }
    if (invoke.onError !== undefined) {
        for (const t of invoke.onError) {
            if (isBucketSymbol(t.target)) usedBuckets.add(t.target);
        }
    }

    const nameByBucket = new Map<EndBucketSymbol, string>();
    const siblings = new Set<string>(Object.keys(states));
    for (const b of usedBuckets) {
        const name = pickEndName(bucketOf(b), Array.from(siblings));
        nameByBucket.set(b, name);
        siblings.add(name);
    }

    runState.invoke.onDone = onDone.map((t): LoweredOnDoneTransition => {
        if (!isBucketSymbol(t.target)) return t;
        const name = nameByBucket.get(t.target);
        return name === undefined ? t : { ...t, target: name };
    });
    if (invoke.onError !== undefined) {
        invoke.onError = invoke.onError.map((t): LoweredOnErrorTransition => {
            if (!isBucketSymbol(t.target)) return t;
            const name = nameByBucket.get(t.target);
            return name === undefined ? t : { ...t, target: name };
        });
    }

    for (const [bucket, name] of nameByBucket) {
        states[name] = makeLeafExitFinalSubstate(bucketOf(bucket));
    }

    // ── foo.onDone ─────────────────────────────────────────────────
    // SPEC 011 §Desugaring: routes the behavior's outcome to the sibling target
    // — built from the mode's `routes` exactly like a compound.
    return {
        initial: startsRunning ? "$run" : "$wait",
        // SPEC 011: a direct entry starts the mode with no event (dry run);
        // `$wait → $run` is internal and keeps the saved event.
        entry: clearEventSlotAction(),
        states,
        onDone: buildModeOnDone(routes, lift, deps),
    };
}
