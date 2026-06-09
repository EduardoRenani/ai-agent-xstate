// Per-outcome `$end_*` substate injection + bucket-aware END rewrite.
//
// Spec: docs/specs/008-compound-mode-routes.md §"Final substate injection —
// per outcome" + §Mapping; supersedes the single-`$end` strategy from spec 004
// (now generalized — `END` keeps its meaning, but the bucket it sits in
// determines which compound outcome it bubbles).
//
// Flow:
//   1. `buildActiveState` / `buildPassiveState` replace each user-written
//      `target: END` with an **internal bucket sentinel** based on the bucket
//      the entry belongs to (`achieved` / `abandoned` / `error`). The sentinel
//      escapes the leaf-build step in the transition's `target` field.
//   2. `compile.ts` walks each level's lowered children, calls
//      `collectEndBuckets` to learn which bucket sentinels surface there, and:
//        - picks a final-substate name per bucket via `pickEndName`
//        - calls `rewriteEndTargets` with the bucket→name map (sentinels →
//          state names)
//        - injects one `$end_<bucket>` final per bucket, with an `output`
//          callback that emits `{ outcome, payload }` to the parent's
//          `onDone` dispatch
//   3. Special case (`rewriteErrorBucketToReThrow`): when the enclosing
//      compound omits `routes.error`, child `routes.error[i].target = END`
//      must re-throw above the compound (spec 008 line 87). The bucket
//      sentinel is rewritten to a target-less throw transition at the leaf,
//      and the `error` bucket is dropped from the level's injection set.
//
// The bucket sentinels are internal symbols — they never appear in the
// user-facing API; `END` (the user-visible symbol) is what the user writes,
// and the leaf-build step is what mints the sentinel.

import { END_ERROR, isBucketSymbol, type EndBucket, type EndBucketSymbol } from "./endBuckets.ts";
import {
    type LiftContext,
    buildSubContext,
} from "./contextLift.ts";
import type {
    LoweredInvokeState,
    LoweredOnDoneTransition,
    LoweredOnErrorTransition,
    LoweredReThrowAction,
} from "./buildActiveState.ts";
import type { RouteTarget } from "./types.ts";

// SPEC 011 §Desugaring: leaf modes now lower to mini-compounds, so the
// `$run`/`$wait`/`$end_*` substates are emitted (and their END buckets
// resolved) inside `buildActiveState`. These atomic-state shapes survive only
// because `injectEnd`'s level-walk still type-handles the *leaf* node case for
// completeness; at runtime every top-level node is a compound or a final.
export type LoweredTransition = {
    target?: RouteTarget | EndBucketSymbol | string;
    actions?: string | readonly string[];
    guard?: (args: { context: unknown; event: unknown }) => boolean;
};

export type LoweredAtomicState = {
    on: Record<string, LoweredTransition | readonly LoweredTransition[]>;
};

export type LoweredLeafState = LoweredAtomicState | LoweredInvokeState;

// ── Final substate emission ──────────────────────────────────────────

// XState v5 final-substate config with an `output` callback. The `output`
// the parent compound's `onDone` dispatches against.
export type FinalOutputFn = (args: {
    context: unknown;
    event: unknown;
}) => { outcome: EndBucket; payload: unknown };

export type LoweredFinalState = {
    readonly type: "final";
    readonly output: FinalOutputFn;
};

// User's compound `output?` callback after the wrapper has stripped the
// generic types. Receives the compound-effective context view; returns the
// payload that bubbles upward as `event.output.payload`.
export type CompoundOutputCb = (args: {
    context: unknown;
    deps: Readonly<Record<string, unknown>>;
}) => unknown;

// Build the final-substate `output` for a non-error bucket. When `outputCb`
// is supplied, it shapes the payload; otherwise payload defaults to
// `undefined`. When a `lift` is in scope (the enclosing compound declared
// `context: { inherit, local }`), the callback sees the lifted view.
function makeNonErrorOutput(
    outcome: "achieved" | "abandoned",
    outputCb: CompoundOutputCb | undefined,
    lift: LiftContext | undefined,
    deps: Readonly<Record<string, unknown>>,
): FinalOutputFn {
    if (outputCb === undefined) {
        return () => ({ outcome, payload: undefined });
    }
    if (lift !== undefined) {
        return ({ context }) => {
            const sub = buildSubContext(context as Record<string, unknown>, lift);
            return { outcome, payload: outputCb({ context: sub, deps }) };
        };
    }
    return ({ context }) => ({
        outcome,
        payload: outputCb({ context, deps }),
    });
}

// Error final substate: payload IS the raw error from the leaf's
// `event.error`. The compound's `routes.error[i].when` (and `assign`) see
// this raw error verbatim — spec 008 line 218 + Verification test 5.
// The compound's `output?` callback intentionally does NOT run for the error
// bucket (errors are not user-shaped payloads).
function makeErrorOutput(): FinalOutputFn {
    return ({ event }) => {
        const e = event as { error?: unknown };
        return { outcome: "error", payload: e.error };
    };
}

export function makeFinalSubstate(
    outcome: EndBucket,
    outputCb: CompoundOutputCb | undefined,
    lift: LiftContext | undefined,
    deps: Readonly<Record<string, unknown>>,
): LoweredFinalState {
    const output =
        outcome === "error"
            ? makeErrorOutput()
            : makeNonErrorOutput(outcome, outputCb, lift, deps);
    return { type: "final" as const, output };
}

// SPEC 011 §Desugaring: a leaf mode's `$end_<bucket>` final FORWARDS the
// behavior's payload (rather than running a compound `output?` callback) so the
// mode's own `foo.onDone` can dispatch/assign on it. The achieved/abandoned
// finals are entered from `$run.invoke.onDone`, where the behavior's
// `ModeResult` lives in `event.output.payload`; the error final is entered from
// `$run.invoke.onError`, where the raw error lives in `event.error`.
function makeLeafForwardOutput(outcome: "achieved" | "abandoned"): FinalOutputFn {
    return ({ event }) => {
        const out = (event as { output?: { payload?: unknown } }).output;
        return { outcome, payload: out === undefined ? undefined : out.payload };
    };
}

export function makeLeafExitFinalSubstate(outcome: EndBucket): LoweredFinalState {
    const output =
        outcome === "error" ? makeErrorOutput() : makeLeafForwardOutput(outcome);
    return { type: "final" as const, output };
}

// ── Collision-safe name picker ───────────────────────────────────────

// `$end_<outcome>` if available, otherwise bump a numeric suffix. The `$`
// prefix is the same collision-avoidance device the v1 single-`$end`
// strategy used; per-outcome keeps the names self-describing.
export function pickEndName(outcome: EndBucket, siblings: readonly string[]): string {
    const base = `$end_${outcome}`;
    const set = new Set(siblings);
    if (!set.has(base)) return base;
    let i = 1;
    while (set.has(`${base}${i}`)) i += 1;
    return `${base}${i}`;
}

// ── Bucket collection / rewrite ──────────────────────────────────────

function isReadonlyArray<T>(value: T | readonly T[]): value is readonly T[] {
    return Array.isArray(value);
}

function isInvoke(state: LoweredLeafState): state is LoweredInvokeState {
    return "invoke" in state;
}

// Returns the set of bucket sentinels referenced anywhere in this state's
// targets. Empty set when the state contains no END references at all.
export function collectEndBuckets(
    state: LoweredLeafState,
): ReadonlySet<EndBucketSymbol> {
    const buckets = new Set<EndBucketSymbol>();
    if (isInvoke(state)) {
        for (const t of state.invoke.onDone) {
            if (isBucketSymbol(t.target)) buckets.add(t.target);
        }
        if (state.invoke.onError !== undefined) {
            for (const t of state.invoke.onError) {
                if (isBucketSymbol(t.target)) buckets.add(t.target);
            }
        }
        return buckets;
    }
    for (const transitions of Object.values(state.on)) {
        const list = isReadonlyArray(transitions) ? transitions : [transitions];
        for (const t of list) {
            if (isBucketSymbol(t.target)) buckets.add(t.target);
        }
    }
    return buckets;
}

function rewritePassiveTransition(
    t: LoweredTransition,
    nameByBucket: ReadonlyMap<EndBucketSymbol, string>,
): LoweredTransition {
    if (!isBucketSymbol(t.target)) return t;
    const name = nameByBucket.get(t.target);
    if (name === undefined) return t;
    return { ...t, target: name };
}

function rewriteOnDoneTransition(
    t: LoweredOnDoneTransition,
    nameByBucket: ReadonlyMap<EndBucketSymbol, string>,
): LoweredOnDoneTransition {
    if (!isBucketSymbol(t.target)) return t;
    const name = nameByBucket.get(t.target);
    if (name === undefined) return t;
    return { ...t, target: name };
}

function rewriteOnErrorTransition(
    t: LoweredOnErrorTransition,
    nameByBucket: ReadonlyMap<EndBucketSymbol, string>,
): LoweredOnErrorTransition {
    if (!isBucketSymbol(t.target)) return t;
    const name = nameByBucket.get(t.target);
    if (name === undefined) return t;
    return { ...t, target: name };
}

// Returns a new lowered state with every bucket sentinel rewritten to the
// corresponding state name from `nameByBucket`. Non-bucket targets,
// `actions`, `guard`, and `reenter` flags are preserved by reference. The
// input is not mutated.
export function rewriteEndTargets(
    state: LoweredLeafState,
    nameByBucket: ReadonlyMap<EndBucketSymbol, string>,
): LoweredLeafState {
    if (isInvoke(state)) {
        const onDone = state.invoke.onDone.map((t) =>
            rewriteOnDoneTransition(t, nameByBucket),
        );
        const invoke: LoweredInvokeState["invoke"] = {
            src: state.invoke.src,
            input: state.invoke.input,
            onDone,
        };
        if (state.invoke.onError !== undefined) {
            invoke.onError = state.invoke.onError.map((t) =>
                rewriteOnErrorTransition(t, nameByBucket),
            );
        }
        return { invoke };
    }
    const on: LoweredAtomicState["on"] = {};
    for (const [event, transitions] of Object.entries(state.on)) {
        on[event] = isReadonlyArray(transitions)
            ? transitions.map((t) => rewritePassiveTransition(t, nameByBucket))
            : rewritePassiveTransition(transitions, nameByBucket);
    }
    return { on };
}

// Special case: when the enclosing compound omits `routes.error`, child
// `routes.error[i].target = END` must re-throw above the compound (spec 008
// line 87 + Verification test 4). Drop the bucket sentinel target and emit
// a target-less throw action — same shape `buildErrorTransition` uses for
// `target: RE_THROW`. The user's `assign` on such an entry is dropped (it
// would not run anyway — the throw aborts the step).
//
// Only applies to active leaves (`invoke.onError`); passive leaves have no
// error transitions to rewrite, and the `error` bucket cannot surface from
// `on[event].target = END` (passive END defaults to `achieved`).
function makeReThrowFromPayload(): LoweredReThrowAction {
    return ({ event }) => {
        throw (event as { error: unknown }).error;
    };
}

export function rewriteErrorBucketToReThrow(
    state: LoweredLeafState,
): LoweredLeafState {
    if (!isInvoke(state)) return state;
    if (state.invoke.onError === undefined) return state;

    const onError = state.invoke.onError.map((t): LoweredOnErrorTransition => {
        if (t.target !== END_ERROR) return t;
        // Drop both `target` and any user `assign` — same convention as the
        // leaf-level RE_THROW path in `buildErrorTransition`.
        const rewritten: LoweredOnErrorTransition = {
            actions: makeReThrowFromPayload(),
        };
        if (t.guard !== undefined) rewritten.guard = t.guard;
        return rewritten;
    });

    const invoke: LoweredInvokeState["invoke"] = {
        src: state.invoke.src,
        input: state.invoke.input,
        onDone: state.invoke.onDone,
        onError,
    };
    return { invoke };
}

