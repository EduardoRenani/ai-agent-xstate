// `xstateBackend` — the single module below `startAgent` that knows XState's
// config vocabulary.
//
// Spec: docs/specs/012-xstate-containment.md §Seam 3 (DD-033).
//
// Phase 4a (boundary): every `import ... from "xstate"` in the lowering layer
// is relocated here, behind Atlas-named primitives, so the lowering modules no
// longer reference the engine directly. After this phase a
// `grep 'from "xstate"'` over `src/` matches exactly two files: this one and
// `startAgent.ts`. (Phase 4b moves the structural synthesis — the `$run`/`$wait`
// mini-compound, `$end_*` injection, done/error event-shape reads — here too,
// behind an Atlas-vocabulary IR, so a future engine swap touches only this file.)

import { assign, fromPromise, setup, type AnyActorLogic, type AnyStateMachine } from "xstate";

import {
    buildSubContext,
    makeCompoundEntry,
    makeCompoundExit,
    type LiftContext,
} from "./contextLift.ts";
import {
    bucketOf,
    bucketSymbol,
    isBucketSymbol,
    type EndBucket,
    type EndBucketSymbol,
} from "./endBuckets.ts";
import { EVENT_SLOT } from "./eventSlot.ts";
import type { CompoundNode, IrAgent, IrGuard, IrNode, IrPatch, ModeNode, OutcomeEdge, ErrorEdge } from "./ir.ts";
import type { Outcome } from "./types.ts";

// ── Carrier structural types (Atlas-neutral aliases) ─────────────────

/** The compiled carrier machine — what `compile` produces and `startAgent` boots. */
export type CarrierMachine = AnyStateMachine;

/** A carrier actor: an invoked behavior. */
export type CarrierActor = AnyActorLogic;

/** A carrier context-update action (the result of wrapping a callback). */
export type AssignAction = ReturnType<typeof assign>;

// ── Value primitives ─────────────────────────────────────────────────

/** Wrap a context-update callback into a carrier action. */
export const wrapAssign = assign;

/** Wrap an async behavior into a carrier promise-actor. */
export const fromPromiseActor = fromPromise;

/**
 * Assemble the carrier machine from the lowered config. Owns the `looseSetup`
 * cast: the lowered shapes are `unknown`-typed by construction (the user's
 * concrete types were discharged at the `defineAgent` call site), and XState's
 * `setup` generics are too strict to satisfy generically — its `MachineContext`
 * constraint collides with an arbitrary `TContext` — so the already-shaped
 * values are handed through `unknown`.
 */
export function createCarrier(args: {
    actors: Record<string, CarrierActor>;
    actions: Record<string, AssignAction>;
    machine: { id: string; initial: string; context: unknown; states: unknown };
}): CarrierMachine {
    const looseSetup = setup as unknown as (cfg: {
        types?: unknown;
        actors?: Record<string, CarrierActor>;
        actions?: Record<string, unknown>;
    }) => { createMachine: (config: unknown) => CarrierMachine };
    return looseSetup({ actors: args.actors, actions: args.actions }).createMachine(args.machine);
}

// ── Engine event-shape readers (collapse the `as unknown as {...}` casts) ──
//
// Spec: docs/specs/012-xstate-containment.md §P22. The lowering layer used to
// reach into XState's done-event / invoke-error shapes with ~13 ad-hoc
// `event as unknown as {...}` casts spread across compile.ts / buildActiveState.ts
// / contextLift.ts. Those engine event shapes are XState vocabulary; this module
// owns them. Each reader takes `unknown` and returns plain data, so a caller may
// import it without importing xstate — keeping the boundary tripwire green.

/**
 * Read an XState invoke `onDone` event's `output` — the behavior's `ModeResult`
 * `{ outcome | stay, payload }` (the shape `buildActiveState`'s `$run.invoke`
 * delivered) OR the `{ outcome, payload }` a `$end_*` final re-emits to a
 * parent compound's `onDone`. `payload`/`outcome`/`stay` are all optional from
 * the reader's perspective — callers narrow on whichever they dispatch.
 */
export function readDoneOutput(event: unknown): {
    outcome?: Outcome | EndBucket;
    stay?: "replay" | "waitOnEvent";
    payload: unknown;
} {
    const out = (event as { output?: { outcome?: Outcome | EndBucket; stay?: "replay" | "waitOnEvent"; payload?: unknown } }).output;
    if (out === undefined) return { payload: undefined };
    return { outcome: out.outcome, stay: out.stay, payload: out.payload };
}

/**
 * Read an XState invoke `onError` event's raw rejection value (`event.error`) —
 * the single-hop shape XState delivers directly on `invoke.onError`.
 */
export function readInvokeError(event: unknown): unknown {
    return (event as { error?: unknown }).error;
}

/**
 * Read the raw error from an event that may arrive in EITHER of two shapes:
 *   - directly from a leaf's `$run.invoke.onError` → `event.error`, OR
 *   - SPEC 011: forwarded by a child mini-compound's `$end_error` final as
 *     `event.output.payload`.
 *
 * The discriminator MUST be `"error" in e` (not `e.error !== undefined`): a
 * behavior may reject with `undefined`, and treating that as "no error" would
 * misroute to `event.output.payload`. Mirrors `injectEnd.makeErrorOutput`.
 */
export function readForwardedError(event: unknown): unknown {
    const e = event as { error?: unknown; output?: { payload?: unknown } };
    return "error" in e ? e.error : e.output?.payload;
}

/**
 * The `meta` key under which a parked mode's `$wait` substate stamps the event
 * types that will resume it. Owned here (the engine `meta` channel is XState
 * vocabulary); `startAgent` reads it back through this same constant.
 *
 * SPEC 011 Clarification #6: XState v5 snapshots don't expose `nextEvents`, so
 * `meta.atlasAwaiting` is how the inspect adapter recovers readiness from the
 * active leaf and surfaces it as `AgentInspectionEvent.awaiting`.
 */
export const ATLAS_AWAITING_META_KEY = "atlasAwaiting" as const;

// ════════════════════════════════════════════════════════════════════════
// IR → XState config translator (SPEC 012 §Seam 3, phase 4b)
// ════════════════════════════════════════════════════════════════════════
//
// `translateAgent(ir)` lowers the carrier-neutral `IrAgent` (src/ir.ts) into a
// `setup().createMachine` config and assembles the carrier. It is the ONLY
// place that knows the `$run`/`$wait` mini-compound shape, the `$end_*` final
// injection + bucket-sentinel rewriting, the `meta.atlasAwaiting` channel, and
// the engine done/error event reads. It reproduces — verbatim in behavior — the
// lowering that today lives across buildActiveState.ts / injectEnd.ts /
// compile.ts; phase 4b lets it COEXIST with that pipeline (compile is not wired
// to it yet) so the swap can be validated before the legacy path is removed.

// ── Config shapes the translator emits (engine vocabulary, internal) ──

type TranslatorGuard = (args: { event: unknown }) => boolean;
type TranslatorErrorGuard = (args: { event: { error: unknown } }) => boolean;
type TranslatorActions = AssignAction | readonly AssignAction[];

type ConfigOnDoneTransition = {
    guard?: TranslatorGuard;
    target?: string | EndBucketSymbol;
    reenter?: boolean;
    actions?: TranslatorActions;
};

type ConfigOnErrorTransition = {
    guard?: TranslatorErrorGuard;
    target?: string | EndBucketSymbol;
    actions?: AssignAction | ((args: { event: { error: unknown } }) => never);
};

type ConfigInvokeState = {
    invoke: {
        src: string;
        input: (args: { context: unknown }) => unknown;
        onDone: readonly ConfigOnDoneTransition[];
        onError?: readonly ConfigOnErrorTransition[];
    };
};

type ConfigWaitState = {
    on: Record<string, { target: string; actions: AssignAction; reenter: true }>;
    meta?: { [ATLAS_AWAITING_META_KEY]: readonly string[] };
};

type ConfigFinalState = {
    readonly type: "final";
    readonly output: (args: { context: unknown; event: unknown }) => { outcome: EndBucket; payload: unknown };
};

type ConfigCompoundState = {
    initial: string;
    states: Record<string, ConfigState>;
    onDone?: readonly ConfigOnDoneTransition[];
    entry?: AssignAction;
    exit?: AssignAction;
};

type ConfigState =
    | ConfigInvokeState
    | ConfigWaitState
    | ConfigFinalState
    | ConfigCompoundState;

// ── Shared value primitives (clear-slot, output forwarding) ───────────

function clearEventSlotAction(): AssignAction {
    // Root-level action clearing the `$event` slot (`event => undefined`).
    return wrapAssign({ [EVENT_SLOT]: () => undefined });
}

// ── Edge → onDone-transition lowering (the dedup target) ──────────────
//
// A single pair of functions lowers the IR's `OutcomeEdge[]` / `ErrorEdge[]`
// into engine `onDone` transitions. Today this logic exists TWICE — once for a
// leaf's `foo.onDone` (buildActiveState.buildFooExitTransition / buildFooError-
// Transition) and once for a compound's `onDone` (compile.buildCompoundExitOnDone
// / buildCompoundErrorOnDone). Both already emit the same shape and both
// dispatch against the `{ outcome, payload }` a `$end_*` final emits — so they
// collapse here. The only prior difference (which `lift` the patch is split
// against) is carried by the caller as `lift`, not as a separate code path.

// Guard: dispatch on `readDoneOutput(event).outcome === bucket`, then the user's
// payload `when`. Identical to makeFooOutcomeGuard / makeCompoundOutcomeGuard.
function makeOutcomeGuard(bucket: EndBucket, userWhen: IrGuard | undefined): TranslatorGuard {
    return ({ event }) => {
        const out = readDoneOutput(event);
        if (out.outcome === undefined) return false;
        if (out.outcome !== bucket) return false;
        if (userWhen === undefined) return true;
        return userWhen(out.payload, undefined);
    };
}

// Exit `assign`: read `event.output.payload`, lift-split when a lift is in
// scope. Mirrors wrapFooExitAssign / wrapCompoundExitAssign. `lift` is the
// scope the patch writes into (a leaf's own lift, or a compound's PARENT lift).
function lowerExitPatch(patch: IrPatch, lift: LiftContext | undefined): AssignAction {
    if (lift !== undefined) {
        return wrapAssign(({ context, event }) => {
            const root = context as Record<string, unknown>;
            const sub = buildSubContext(root, lift);
            const payload = readDoneOutput(event).payload;
            const update = patch(sub, payload) as Record<string, unknown>;
            return splitUserUpdate(update, root, lift);
        });
    }
    return wrapAssign(({ context, event }) => {
        const payload = readDoneOutput(event).payload;
        return patch(context, payload);
    });
}

// Error `assign`: the raw error reaches `foo.onDone[error]` as
// `event.output.payload` (forwarded by the `$end_error` final). Mirrors
// wrapFooErrorAssign / wrapCompoundErrorAssign + liftErrorAssignFromOutput.
function lowerErrorPatch(patch: IrPatch, lift: LiftContext | undefined): AssignAction {
    if (lift !== undefined) {
        return wrapAssign(({ context, event }) => {
            const root = context as Record<string, unknown>;
            const sub = buildSubContext(root, lift);
            const error = readDoneOutput(event).payload;
            const update = patch(sub, error) as Record<string, unknown>;
            return splitUserUpdate(update, root, lift);
        });
    }
    return wrapAssign(({ context, event }) => {
        const error = readDoneOutput(event).payload;
        return patch(context, error);
    });
}

// The `{kind:"abort"}` translation on a `foo.onDone` error edge — re-throw the
// forwarded error and DROP any user patch (matching buildFooErrorTransition /
// buildCompoundErrorOnDone / rewriteCompoundErrorBucketToReThrow, all of which
// throw `event.output.payload` from inside a `wrapAssign` and discard `assign`).
function makeAbortAction(): AssignAction {
    return wrapAssign(({ event }) => {
        throw readForwardedError(event);
    });
}

function lowerOutcomeEdges(
    edges: readonly OutcomeEdge[],
    lift: LiftContext | undefined,
): ConfigOnDoneTransition[] {
    return edges.map((edge): ConfigOnDoneTransition => {
        const transition: ConfigOnDoneTransition = {
            guard: makeOutcomeGuard(edge.bucket, edge.guard),
        };
        // {kind:"end"} → bucket sentinel (the level injection rewrites it to a
        // `$end_<bucket>` sibling); {kind:"state"} → sibling name verbatim.
        if (edge.target.kind === "end") {
            transition.target = bucketSymbol(edge.target.bucket);
        } else if (edge.target.kind === "state") {
            transition.target = edge.target.name;
        }
        if (edge.patch !== undefined) {
            transition.actions = lowerExitPatch(edge.patch, lift);
        }
        return transition;
    });
}

function lowerErrorEdges(
    edges: readonly ErrorEdge[],
    lift: LiftContext | undefined,
): ConfigOnDoneTransition[] {
    return edges.map((edge): ConfigOnDoneTransition => {
        const guard = makeOutcomeGuard("error", edge.guard);
        if (edge.target.kind === "abort") {
            // Re-throw — user patch dropped (the throw IS the side effect).
            return { guard, actions: makeAbortAction() };
        }
        const transition: ConfigOnDoneTransition = { guard };
        if (edge.target.kind === "end") {
            transition.target = bucketSymbol(edge.target.bucket);
        } else {
            transition.target = edge.target.name;
        }
        if (edge.patch !== undefined) {
            transition.actions = lowerErrorPatch(edge.patch, lift);
        }
        return transition;
    });
}

// ── $end_* final substates (forwarding + injection + collision naming) ──

function makeLeafForwardOutput(outcome: "achieved" | "abandoned"): ConfigFinalState["output"] {
    return ({ event }) => ({ outcome, payload: readDoneOutput(event).payload });
}

function makeErrorOutput(): ConfigFinalState["output"] {
    // Reads the raw error in either shape via readForwardedError (mirrors
    // injectEnd.makeErrorOutput).
    return ({ event }) => ({ outcome: "error", payload: readForwardedError(event) });
}

function makeLeafExitFinal(outcome: EndBucket): ConfigFinalState {
    const output = outcome === "error" ? makeErrorOutput() : makeLeafForwardOutput(outcome);
    return { type: "final" as const, output };
}

// A compound-level `$end_*` final: non-error buckets run the compound's `output`
// callback (lifted when a lift is in scope); error forwards the raw error.
// Mirrors injectEnd.makeFinalSubstate + makeNonErrorOutput.
function makeCompoundFinal(
    outcome: EndBucket,
    outputCb: ((args: { context: unknown; deps: Readonly<Record<string, unknown>> }) => unknown) | undefined,
    lift: LiftContext | undefined,
    deps: Readonly<Record<string, unknown>>,
): ConfigFinalState {
    if (outcome === "error") return { type: "final" as const, output: makeErrorOutput() };
    if (outputCb === undefined) {
        return { type: "final" as const, output: () => ({ outcome, payload: undefined }) };
    }
    if (lift !== undefined) {
        return {
            type: "final" as const,
            output: ({ context }) => {
                const sub = buildSubContext(context as Record<string, unknown>, lift);
                return { outcome, payload: outputCb({ context: sub, deps }) };
            },
        };
    }
    return {
        type: "final" as const,
        output: ({ context }) => ({ outcome, payload: outputCb({ context, deps }) }),
    };
}

// `$end_<outcome>` if free, else a bumped numeric suffix. Mirrors
// injectEnd.pickEndName EXACTLY (same `$`-prefix + counter) — the minted names
// are part of the persisted `value` shape, so the algorithm must not drift.
function pickEndName(outcome: EndBucket, siblings: readonly string[]): string {
    const base = `$end_${outcome}`;
    const set = new Set(siblings);
    if (!set.has(base)) return base;
    let i = 1;
    while (set.has(`${base}${i}`)) i += 1;
    return `${base}${i}`;
}

// ── ModeNode → `$run`/`$wait` mini-compound synthesis ─────────────────
//
// Reproduces buildActiveState.ts:494-606. Owns: initial `$run`|`$wait`,
// entry:clearEventSlot, `$run.invoke{src,input,onDone,onError}`, `$wait{on,meta}`,
// the LOCAL `$end_*` mint, and `foo.onDone` from exits/errors.

function buildRunInput(
    node: ModeNode,
    deps: Readonly<Record<string, unknown>>,
): (args: { context: unknown }) => unknown {
    // `$run.invoke.input` reads the waking event from the `$event` slot and
    // passes it alongside the user's derived input: `{ userInput, event }`.
    return ({ context }) => {
        const root = context as Record<string, unknown>;
        const event = root[EVENT_SLOT];
        const userInput = node.input({ context, deps });
        return { userInput, event };
    };
}

function makeStayGuard(stayKey: "replay" | "waitOnEvent"): TranslatorGuard {
    return ({ event }) => readDoneOutput(event).stay === stayKey;
}

// A STAY continuation's `assign` reads `event.output.payload`; lift-split when a
// lift is in scope. Mirrors buildActiveState.wrapStayAssign.
function lowerStayPatch(patch: IrPatch, lift: LiftContext | undefined): AssignAction {
    return lowerExitPatch(patch, lift);
}

function buildWaitState(events: readonly string[]): ConfigWaitState {
    const on: ConfigWaitState["on"] = {};
    for (const eventType of events) {
        on[eventType] = {
            target: "$run",
            actions: wrapAssign(({ event }) => ({ [EVENT_SLOT]: event })),
            // reenter is load-bearing — without it the invoke does not restart.
            reenter: true,
        };
    }
    return { on, meta: { [ATLAS_AWAITING_META_KEY]: events } };
}

function synthesizeModeCompound(
    node: ModeNode,
    deps: Readonly<Record<string, unknown>>,
): ConfigCompoundState {
    const startsRunning = !node.startsParked;

    // ── $run.invoke.onDone ──
    const onDone: ConfigOnDoneTransition[] = [];
    // Exits: one outcome-only guard per LEAVE bucket → LOCAL final sentinel.
    onDone.push({ guard: makeOutcomeGuard("achieved", undefined), target: bucketSymbol("achieved") });
    onDone.push({ guard: makeOutcomeGuard("abandoned", undefined), target: bucketSymbol("abandoned") });

    // Continuations.
    if (node.replay !== undefined) {
        const transition: ConfigOnDoneTransition = {
            guard: makeStayGuard("replay"),
            target: "$run",
            reenter: true, // replay self-loop always reenters (restart the invoke).
        };
        const actions: AssignAction[] = [];
        // active CLEARS the slot (no event); passive KEEPS it (same event). The
        // clear action MUST be ordered first (it composes before the user patch).
        if (startsRunning) actions.push(clearEventSlotAction());
        if (node.replay.patch !== undefined) actions.push(lowerStayPatch(node.replay.patch, node.contextLift));
        if (actions.length === 1) transition.actions = actions[0];
        else if (actions.length > 1) transition.actions = actions;
        onDone.push(transition);
    }
    if (node.waitOnEvent !== undefined) {
        const transition: ConfigOnDoneTransition = {
            guard: makeStayGuard("waitOnEvent"),
            target: "$wait",
        };
        if (node.waitOnEvent.patch !== undefined) {
            transition.actions = lowerStayPatch(node.waitOnEvent.patch, node.contextLift);
        }
        onDone.push(transition);
    }

    // ── $run.invoke ──
    const invoke: ConfigInvokeState["invoke"] = {
        src: node.actorName,
        input: buildRunInput(node, deps),
        onDone,
    };

    // routes.error → $run.invoke.onError. An error edge here is outcome-only:
    // it targets the local `$end_error` bucket (carrying the raw error), and
    // `foo.onDone`'s error edge applies the user's target/assign. A {kind:abort}
    // error edge re-throws directly off the invoke.
    if (node.errors.length > 0) {
        const onError: ConfigOnErrorTransition[] = [];
        for (const edge of node.errors) {
            const guard: TranslatorErrorGuard = ({ event }) => {
                if (edge.guard === undefined) return true;
                return edge.guard(readInvokeError(event), undefined);
            };
            if (edge.target.kind === "abort") {
                // `$run.invoke.onError` re-throw: a bare inline action that
                // throws the raw `event.error` (mirrors buildErrorTransition's
                // makeReThrowAction — NOT wrapped in assign).
                const reThrow = (args: { event: { error: unknown } }): never => {
                    throw readInvokeError(args.event);
                };
                onError.push({ guard, actions: reThrow });
            } else {
                onError.push({ guard, target: bucketSymbol("error") });
            }
        }
        invoke.onError = onError;
    }

    const runState: ConfigInvokeState = { invoke };

    // ── states map (+ LOCAL $end_* injection) ──
    const states: Record<string, ConfigState> = {
        $run: runState,
        $wait: buildWaitState(node.awaitedEvents),
    };

    // Collect bucket sentinels used by onDone/onError, mint collision-safe
    // names against the SAME sibling set + order buildActiveState used.
    const usedBuckets = new Set<EndBucketSymbol>();
    for (const t of onDone) if (isBucketSymbol(t.target)) usedBuckets.add(t.target);
    if (invoke.onError !== undefined) {
        for (const t of invoke.onError) if (isBucketSymbol(t.target)) usedBuckets.add(t.target);
    }
    const nameByBucket = new Map<EndBucketSymbol, string>();
    const siblings = new Set<string>(Object.keys(states));
    for (const b of usedBuckets) {
        const name = pickEndName(bucketOf(b), Array.from(siblings));
        nameByBucket.set(b, name);
        siblings.add(name);
    }

    runState.invoke.onDone = onDone.map((t): ConfigOnDoneTransition => {
        if (!isBucketSymbol(t.target)) return t;
        const name = nameByBucket.get(t.target);
        return name === undefined ? t : { ...t, target: name };
    });
    if (invoke.onError !== undefined) {
        invoke.onError = invoke.onError.map((t): ConfigOnErrorTransition => {
            if (!isBucketSymbol(t.target)) return t;
            const name = nameByBucket.get(t.target);
            return name === undefined ? t : { ...t, target: name };
        });
    }
    for (const [bucket, name] of nameByBucket) {
        states[name] = makeLeafExitFinal(bucketOf(bucket));
    }

    // ── foo.onDone ── routes the behavior's outcome to the sibling target.
    // Exits lower against the leaf's OWN lift; errors likewise (the raw error
    // reaches foo.onDone via the local `$end_error` final).
    const fooOnDone: ConfigOnDoneTransition[] = [
        ...lowerOutcomeEdges(node.exits, node.contextLift),
        ...lowerErrorEdges(node.errors, node.contextLift),
    ];

    return {
        initial: startsRunning ? "$run" : "$wait",
        // A direct entry starts the mode with no event (dry run); the internal
        // `$wait → $run` does not re-enter the compound, so the saved event survives.
        entry: clearEventSlotAction(),
        states,
        onDone: fooOnDone,
    };
}

// ── Level walk: bucket collection / rewrite / `$end_*` injection ──────

function collectNodeBuckets(state: ConfigState): ReadonlySet<EndBucketSymbol> {
    const out = new Set<EndBucketSymbol>();
    if ("onDone" in state && state.onDone !== undefined) {
        for (const t of state.onDone) if (isBucketSymbol(t.target)) out.add(t.target);
    }
    return out;
}

function rewriteCompoundOnDone(
    state: ConfigCompoundState,
    nameByBucket: ReadonlyMap<EndBucketSymbol, string>,
): ConfigCompoundState {
    if (state.onDone === undefined) return state;
    const onDone = state.onDone.map((t): ConfigOnDoneTransition => {
        if (!isBucketSymbol(t.target)) return t;
        const name = nameByBucket.get(t.target);
        return name === undefined ? t : { ...t, target: name };
    });
    return { ...state, onDone };
}

// When the enclosing compound omits `routes.error`, a child mini-compound whose
// `onDone[i].target === END_ERROR` must re-throw above this compound. The error
// reaches it via `event.output.payload` (the `$end_error` final forwarded it).
// Mirrors compile.rewriteCompoundErrorBucketToReThrow.
function rewriteErrorBucketToAbort(state: ConfigCompoundState): ConfigCompoundState {
    if (state.onDone === undefined) return state;
    const errorSym = bucketSymbol("error");
    const onDone = state.onDone.map((t): ConfigOnDoneTransition => {
        if (t.target !== errorSym) return t;
        const rewritten: ConfigOnDoneTransition = {
            actions: wrapAssign(({ event }) => {
                throw readForwardedError(event);
            }),
        };
        if (t.guard !== undefined) rewritten.guard = t.guard;
        return rewritten;
    });
    return { ...state, onDone };
}

function injectEndAtLevel(
    states: Record<string, ConfigState>,
    outputCb: ((args: { context: unknown; deps: Readonly<Record<string, unknown>> }) => unknown) | undefined,
    lift: LiftContext | undefined,
    deps: Readonly<Record<string, unknown>>,
): Record<string, ConfigState> {
    const buckets = new Set<EndBucketSymbol>();
    for (const node of Object.values(states)) {
        for (const b of collectNodeBuckets(node)) buckets.add(b);
    }
    if (buckets.size === 0) return states;

    const nameByBucket = new Map<EndBucketSymbol, string>();
    const siblings = new Set<string>(Object.keys(states));
    for (const b of buckets) {
        const name = pickEndName(bucketOf(b), Array.from(siblings));
        nameByBucket.set(b, name);
        siblings.add(name);
    }

    const rewritten: Record<string, ConfigState> = {};
    for (const [name, node] of Object.entries(states)) {
        rewritten[name] =
            "onDone" in node && node.onDone !== undefined
                ? rewriteCompoundOnDone(node as ConfigCompoundState, nameByBucket)
                : node;
    }
    for (const [bucket, name] of nameByBucket) {
        rewritten[name] = makeCompoundFinal(bucketOf(bucket), outputCb, lift, deps);
    }
    return rewritten;
}

// ── IR node → config state ────────────────────────────────────────────

// `parentLift` is the lift of the ENCLOSING scope (undefined at the root). A
// compound lowers its own `onDone` against it (the compound's own slot is torn
// down before `onDone` fires — compile.ts:341-344/645). A mode lowers its exits
// against its OWN lift (`node.contextLift`), so it ignores `parentLift`.
function translateNode(
    node: IrNode,
    parentLift: LiftContext | undefined,
    deps: Readonly<Record<string, unknown>>,
): ConfigState {
    if (node.kind === "mode") return synthesizeModeCompound(node, deps);
    return translateCompound(node, parentLift, deps);
}

function translateChildren(
    children: Record<string, IrNode>,
    parentLift: LiftContext | undefined,
    deps: Readonly<Record<string, unknown>>,
): Record<string, ConfigState> {
    const out: Record<string, ConfigState> = {};
    for (const [name, child] of Object.entries(children)) {
        out[name] = translateNode(child, parentLift, deps);
    }
    return out;
}

function translateCompound(
    node: CompoundNode,
    parentLift: LiftContext | undefined,
    deps: Readonly<Record<string, unknown>>,
): ConfigCompoundState {
    // `node.contextLift` is this compound's OWN lift — present iff it declared
    // `context: { inherit, local }`. When present, children + this level's
    // `$end_*` injection are lowered under it, and entry/exit slot actions are
    // emitted; when absent, children inherit `parentLift` and no slot is
    // allocated (mirrors compile.ts `childLift`/`ownEntry`/`ownExit`).
    const ownLift = node.contextLift;
    const childLift = ownLift ?? parentLift;

    // 1. Lower children under this compound's child-lift.
    const childStatesRaw = translateChildren(node.children, childLift, deps);

    // 2. Omitted `routes.error` → re-throw above this compound for the leaf-mode
    //    children whose error END bubbles here. Real nested compounds keep their
    //    prior behavior. The IR carries `errorOmitted` to drive this.
    let childStatesAfterErrorFixup = childStatesRaw;
    if (node.errorOmitted) {
        const fixed: Record<string, ConfigState> = {};
        for (const [name, child] of Object.entries(childStatesRaw)) {
            const irChild = node.children[name];
            if (irChild !== undefined && irChild.kind === "mode" && "onDone" in child) {
                fixed[name] = rewriteErrorBucketToAbort(child as ConfigCompoundState);
            } else {
                fixed[name] = child;
            }
        }
        childStatesAfterErrorFixup = fixed;
    }

    // 3. Inject this compound's own `$end_*` finals. `output` + `childLift` are
    //    this compound's own — the finals' `output` callbacks run inside it.
    const childStates = injectEndAtLevel(childStatesAfterErrorFixup, node.output, childLift, deps);

    // 4. Build this compound's `onDone` from its exits/errors. Targets/assigns
    //    execute in the PARENT scope (after this compound exits), so they lower
    //    against `parentLift` (compile.ts:645 / :341-344).
    const onDone: ConfigOnDoneTransition[] = [
        ...lowerOutcomeEdges(node.exits, parentLift),
        ...lowerErrorEdges(node.errors, parentLift),
    ];

    const compound: ConfigCompoundState = {
        initial: node.initial,
        states: childStates,
        onDone,
    };
    if (ownLift !== undefined) {
        compound.entry = makeCompoundEntry(ownLift);
        compound.exit = makeCompoundExit(ownLift);
    }
    return compound;
}

/**
 * Translate a carrier-neutral `IrAgent` into the assembled carrier machine.
 * Walks the IR tree (ModeNode → `$run`/`$wait` mini-compound; CompoundNode →
 * nested compound with entry/exit + `$end_*` injection), injects the root-level
 * `$end_*` finals, and hands the config to `createCarrier`.
 *
 * Coexists with the legacy compile pipeline (phase 4b): not yet wired into
 * `compile`. Owns the `looseSetup` cast (via createCarrier), the actor registry
 * (`ir.actors` wrapped through `fromPromiseActor`), and the named-actions map.
 */
export function translateAgent(
    ir: IrAgent,
    deps: Readonly<Record<string, unknown>>,
): CarrierMachine {
    // Actor registry: wrap each Atlas-neutral behavior into a carrier promise
    // actor, unpacking the `{ userInput, event }` envelope synthesized by
    // `buildRunInput`.
    const actors: Record<string, CarrierActor> = {};
    for (const [name, behavior] of Object.entries(ir.actors)) {
        actors[name] = fromPromiseActor(async ({ input }) => {
            const envelope = input as { userInput: unknown; event: unknown };
            return behavior({ input: envelope.userInput, event: envelope.event, deps });
        });
    }

    // Named actions: wrap each into an assign action.
    const actions: Record<string, AssignAction> = {};
    for (const [name, cb] of Object.entries(ir.namedActions)) {
        actions[name] = wrapAssign(({ context, event }) =>
            cb({ context, event: event as { type: string }, deps }),
        );
    }

    const lowered = translateChildren(ir.children, undefined, deps);
    const states = injectEndAtLevel(lowered, undefined, undefined, deps);

    return createCarrier({
        actors,
        actions,
        machine: { id: ir.id, initial: ir.initial, context: ir.context, states },
    });
}

// ── Local lift-split (private; mirrors contextLift.splitUserUpdate) ───
//
// The translator's exit/error patch lowering must split a user's
// `Partial<combined>` back to the right root/slot destinations. This is the
// same algorithm contextLift exports (and compile.ts duplicated as
// `splitUserUpdateForParentLift`); kept private here because the translator is
// the consumer and contextLift may not import this module's xstate-touched code
// in the other direction.
function splitUserUpdate(
    update: Record<string, unknown>,
    rootContext: Record<string, unknown>,
    lift: LiftContext,
): Record<string, unknown> {
    const ownLocals = Object.keys(lift.initialLocal);
    const rootPatch: Record<string, unknown> = {};
    const slotPatches: Record<string, Record<string, unknown>> = {};

    function touchSlot(slotKey: string, k: string, v: unknown): void {
        const existing = slotPatches[slotKey] ?? {};
        existing[k] = v;
        slotPatches[slotKey] = existing;
    }

    function findInheritOwner(
        key: string,
        parent: LiftContext | undefined,
    ): { kind: "root" } | { kind: "slot"; slotKey: string } {
        if (parent === undefined) return { kind: "root" };
        if (Object.keys(parent.initialLocal).includes(key)) {
            return { kind: "slot", slotKey: parent.key };
        }
        return findInheritOwner(key, parent.parent);
    }

    for (const [k, v] of Object.entries(update)) {
        if (ownLocals.includes(k)) {
            touchSlot(lift.key, k, v);
            continue;
        }
        if (lift.inherit.includes(k)) {
            const owner = findInheritOwner(k, lift.parent);
            if (owner.kind === "root") rootPatch[k] = v;
            else touchSlot(owner.slotKey, k, v);
            continue;
        }
    }

    for (const [slotKey, patch] of Object.entries(slotPatches)) {
        const current = (rootContext[slotKey] ?? {}) as Record<string, unknown>;
        rootPatch[slotKey] = { ...current, ...patch };
    }
    return rootPatch;
}
