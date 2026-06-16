// `compile` — lowers an `AgentConfig` tree into an XState machine.
//
// Spec: docs/specs/004-xstate-agent-wrapper.md §"Wrapper internals (compile.ts)"
//        + spec 008 §Mapping (per-outcome final substates + compound onDone[]).
// Tasks: docs/specs/004-tasks.md Phase 5.16 (final emit).
// Spec 005: closes over a frozen `deps` reference and threads it to every
//           build* helper. `deps` is NOT placed in XState context — it lives
//           in callback closures, so `JSON.stringify(actor.getSnapshot().context)`
//           returns only TContext (+ synthetic compound-local slots).
//
// Compound lowering (spec 008):
//   - `CompoundMode.routes` is the same four-bucket shape `Mode.routes` uses;
//     `retry: readonly []` is shape-only (compounds never bubble retry).
//   - The compound's `onDone[]` is built from `cfg.routes` — one entry per
//     bucket entry, in order. Achieved/abandoned use the same `buildExitTransition`
//     the leaf uses; error needs a different builder because the error
//     payload lives in `event.output.payload` (not `event.error`) once the
//     leaf has already routed through `$end_error`.
//   - Per-outcome final substates `$end_achieved` / `$end_abandoned` /
//     `$end_error` are injected per compound, one per bucket that any child
//     references. The final's `output` callback emits `{ outcome, payload }`
//     for the parent compound's `onDone[]` dispatch.
//   - Special case: when the compound omits `routes.error`, child END
//     references in `routes.error` are rewritten to re-throw (matching the
//     spec-005 "loud failure" default).
//
// SPEC 012 §Seam 3 (DD-033): `compile` orchestrates the lowering but no longer
// touches the engine — it hands the lowered config to `xstateBackend`, the one
// module that calls `setup().createMachine`. It composes the toolkit slices
// built in 5.1–5.15 + the spec-008 additions:
//   - validateTargets, validateRoutes   (fail-fast at machine creation)
//   - walk + actorName + buildActors    (active-leaf actor map)
//   - buildActions                      (named-actions map)
//   - buildActiveState                  (per-leaf mini-compound lowering, lift-aware)
//   - contextLift                       (LiftContext + entry/exit assigns)
//   - injectEnd                         (per-outcome `$end_*` + bucket → name)
//
// `defineAgent` returns this value verbatim.

import { createCarrier, wrapAssign, type AssignAction, type CarrierMachine } from "./xstateBackend.ts";

import { buildActions } from "./buildActions.ts";
import {
    buildActiveState,
    type LoweredModeCompound,
    type LoweredOnDoneTransition,
} from "./buildActiveState.ts";
import { buildActors } from "./buildActors.ts";
import {
    buildSubContext,
    compoundLocalKey,
    makeCompoundEntry,
    makeCompoundExit,
    type LiftContext,
} from "./contextLift.ts";
import {
    END_ABANDONED,
    END_ACHIEVED,
    END_ERROR,
    bucketOf,
    isBucketSymbol,
    type EndBucket,
    type EndBucketSymbol,
} from "./endBuckets.ts";
import {
    collectEndBuckets,
    makeFinalSubstate,
    pickEndName,
    rewriteEndTargets,
    rewriteErrorBucketToReThrow,
    type CompoundOutputCb,
    type LoweredFinalState,
    type LoweredLeafState,
} from "./injectEnd.ts";
import { END, RE_THROW } from "./types.ts";
import type {
    AgentConfig,
    ErrorEntry,
    ExitEntry,
    JsonObject,
    ModesMap,
    ModeConfig,
    RouteList,
} from "./types.ts";
import { validateRoutes } from "./validateRoutes.ts";
import { validateTargets } from "./validateTargets.ts";
import { walk, type LeafSlot } from "./walk.ts";

// ── Internal lowered shapes ──────────────────────────────────────────

type LoweredCompoundState = {
    initial: string;
    states: Record<string, LoweredState>;
    // Built from `cfg.routes` — one entry per bucket entry in declared
    // order (achieved, then error if present; retry is shape-only and
    // skipped). Bucket sentinels in `target` are rewritten by the *outer*
    // level's `injectEndAtLevel`.
    onDone?: readonly LoweredOnDoneTransition[];
    entry?: AssignAction;
    exit?: AssignAction;
};

// SPEC 011 §Desugaring (DD-029): a leaf mode lowers to a mini-compound
// (`LoweredModeCompound`). It is structurally a compound to this level's
// walk — `isCompound` matches it, and its `onDone` carries the route-target
// bucket sentinels the parent level resolves, exactly like a real compound.
type LoweredState =
    | LoweredLeafState
    | LoweredCompoundState
    | LoweredModeCompound
    | LoweredFinalState;

// ── Carrier shapes (runtime discriminator) ───────────────────────────
//
// Re-declared as loose runtime shapes — the user's generic types have done
// their job at the call site (defineMode / defineCompoundMode). The walk
// layer only reads the runtime payload.

// Internal "loose" placeholder for TContext at the carrier layer. The type
// system has already enforced `JsonCompatible<TContext>` at the user's
// `defineMode` / `defineCompoundMode` / `defineAgent` call site; here we
// only need a structural pass-through that itself satisfies the JSON
// constraint so the alias references compile. `JsonObject` is a
// self-referential JSON shape (its value type is `JsonValue`), the loosest
// such anchor.
type InternalCtx = JsonObject;

type LeafCarrier = {
    readonly __kind: "leaf";
    readonly config: ModeConfig<InternalCtx, { type: string }, unknown>;
};

type CompoundRoutesLoose = {
    readonly achieved:
        | ExitEntry<InternalCtx, unknown>
        | RouteList<ExitEntry<InternalCtx, unknown>>;
    readonly retry: readonly [];
    readonly abandoned:
        | ExitEntry<InternalCtx, unknown>
        | RouteList<ExitEntry<InternalCtx, unknown>>;
    readonly error?:
        | ErrorEntry<InternalCtx>
        | RouteList<ErrorEntry<InternalCtx>>;
};

type CompoundCarrier = {
    readonly __kind: "compound";
    readonly config: {
        readonly initial: string;
        readonly modes: Record<string, unknown>;
        readonly routes: CompoundRoutesLoose;
        readonly output?: CompoundOutputCb;
        readonly context?: {
            readonly inherit: readonly string[];
            readonly local: Readonly<Record<string, unknown>>;
        };
    };
};

function asCarrier(value: unknown): LeafCarrier | CompoundCarrier {
    return value as LeafCarrier | CompoundCarrier;
}

// ── Lowered-state classifiers ────────────────────────────────────────

// Both a real compound (`LoweredCompoundState`) and a leaf-mode mini-compound
// (`LoweredModeCompound`) expose their parent-facing bucket sentinels via an
// optional `onDone`. The level-walk only ever reads/rewrites that field.
type AnyCompound = LoweredCompoundState | LoweredModeCompound;

function isCompound(node: LoweredState): node is AnyCompound {
    return "initial" in node && "states" in node;
}

function isFinal(node: LoweredState): node is LoweredFinalState {
    return "type" in node && node.type === "final";
}

function isLeaf(node: LoweredState): node is LoweredLeafState {
    return !isCompound(node) && !isFinal(node);
}

function isReadonlyArray<T>(value: T | readonly T[]): value is readonly T[] {
    return Array.isArray(value);
}

// ── Bucket collection over any node at this level ────────────────────
//
// Leaves expose buckets via `injectEnd.collectEndBuckets`. Compound nodes
// expose buckets via their own `onDone[]` entries (sentinels chain upward
// through nested compounds). Final states never carry sentinels.
function collectBucketsForNode(node: LoweredState): ReadonlySet<EndBucketSymbol> {
    if (isFinal(node)) return new Set();
    if (isLeaf(node)) return collectEndBuckets(node);
    const out = new Set<EndBucketSymbol>();
    if (node.onDone === undefined) return out;
    for (const t of node.onDone) {
        if (isBucketSymbol(t.target)) out.add(t.target);
    }
    return out;
}

function rewriteCompoundOnDone<T extends AnyCompound>(
    node: T,
    nameByBucket: ReadonlyMap<EndBucketSymbol, string>,
): T {
    if (node.onDone === undefined) return node;
    const onDone = node.onDone.map((t): LoweredOnDoneTransition => {
        if (!isBucketSymbol(t.target)) return t;
        const name = nameByBucket.get(t.target);
        if (name === undefined) return t;
        return { ...t, target: name };
    });
    return { ...node, onDone };
}

function rewriteNodeBuckets(
    node: LoweredState,
    nameByBucket: ReadonlyMap<EndBucketSymbol, string>,
): LoweredState {
    if (isFinal(node)) return node;
    if (isLeaf(node)) return rewriteEndTargets(node, nameByBucket);
    return rewriteCompoundOnDone(node, nameByBucket);
}

// When the enclosing compound omits `routes.error`, a child's error path that
// bubbles `END` must re-throw above this compound (spec 008 line 87). A child
// can carry the `END_ERROR` sentinel in two shapes at this level:
//   - a plain leaf (`invoke.onError`) — `rewriteErrorBucketToReThrow`.
//   - a (mode- or real) compound whose `onDone[i].target === END_ERROR` — that
//     entry dispatches against the `$end_error` final's emitted
//     `{ outcome:"error", payload: <error> }`, so the throw reads
//     `event.output.payload` (SPEC 011 §Desugaring — a leaf mode is a
//     mini-compound, so its `error` END now surfaces on `onDone`, not
//     `invoke.onError`).
function rewriteCompoundErrorBucketToReThrow<T extends AnyCompound>(node: T): T {
    if (node.onDone === undefined) return node;
    const onDone = node.onDone.map((t): LoweredOnDoneTransition => {
        if (t.target !== END_ERROR) return t;
        const rewritten: LoweredOnDoneTransition = {
            actions: wrapAssign(({ event }) => {
                throw (event as unknown as { output: { payload: unknown } }).output.payload;
            }),
        };
        if (t.guard !== undefined) rewritten.guard = t.guard;
        return rewritten;
    });
    return { ...node, onDone };
}

// `leafModeNames` are the children that lowered from `defineMode` (now
// mini-compounds). The re-throw default applies to *leaf modes* only — exactly
// as it applied to plain-leaf children before unification. Real nested
// compounds keep their prior behavior (their error END is NOT rewritten here;
// it surfaces as a `$end_error` final at this level).
function rewriteErrorBucketAtLevel(
    states: Record<string, LoweredState>,
    leafModeNames: ReadonlySet<string>,
): Record<string, LoweredState> {
    const out: Record<string, LoweredState> = {};
    for (const [name, node] of Object.entries(states)) {
        if (isFinal(node)) {
            out[name] = node;
        } else if (isLeaf(node)) {
            out[name] = rewriteErrorBucketToReThrow(node);
        } else if (isCompound(node) && leafModeNames.has(name)) {
            out[name] = rewriteCompoundErrorBucketToReThrow(node);
        } else {
            out[name] = node;
        }
    }
    return out;
}

// ── Per-outcome `$end_*` injection ───────────────────────────────────
//
// Walks the level's states, collects bucket sentinels referenced anywhere,
// picks a final-substate name per distinct bucket, rewrites every sentinel
// to its name, and injects the final substates with their `output`
// callbacks. `outputCb` (the compound's user-declared `output?`) is woven
// into the non-error finals; the error final's payload is the raw error.
//
// At the agent root: `outputCb` and `lift` are both `undefined` (the agent
// itself has no `output?` callback and no enclosing lift).
function injectEndAtLevel(
    states: Record<string, LoweredState>,
    outputCb: CompoundOutputCb | undefined,
    lift: LiftContext | undefined,
    deps: Readonly<Record<string, unknown>>,
): Record<string, LoweredState> {
    const buckets = new Set<EndBucketSymbol>();
    for (const node of Object.values(states)) {
        for (const b of collectBucketsForNode(node)) buckets.add(b);
    }
    if (buckets.size === 0) return states;

    const nameByBucket = new Map<EndBucketSymbol, string>();
    const siblings = new Set<string>(Object.keys(states));
    for (const b of buckets) {
        const name = pickEndName(bucketOf(b), Array.from(siblings));
        nameByBucket.set(b, name);
        siblings.add(name);
    }

    const rewritten: Record<string, LoweredState> = {};
    for (const [name, node] of Object.entries(states)) {
        rewritten[name] = rewriteNodeBuckets(node, nameByBucket);
    }
    for (const [bucket, name] of nameByBucket) {
        rewritten[name] = makeFinalSubstate(bucketOf(bucket), outputCb, lift, deps);
    }
    return rewritten;
}

// ── Compound onDone[] builders ───────────────────────────────────────

// Compound onDone[] guard. The compound dispatches against the
// `{ outcome, payload }` shape its `$end_*` finals emit. `outcomeKey` is
// the bucket the entry belongs to (achieved/abandoned/error); `payload`
// is whatever the compound's `output?` produced for achieved/abandoned, or
// the raw error for the error bucket.
function makeCompoundOutcomeGuard(
    outcomeKey: EndBucket,
    userWhen: ((payload: unknown) => boolean) | undefined,
): (args: { event: unknown }) => boolean {
    return ({ event }) => {
        const out = (event as { output?: { outcome?: unknown; payload?: unknown } })
            .output;
        if (out === undefined) return false;
        if (out.outcome !== outcomeKey) return false;
        if (userWhen === undefined) return true;
        return userWhen(out.payload);
    };
}

// Wrap a user `wrapAssign({ context, payload, deps })` for a compound exit
// entry. Differs from the leaf-level `wrapAssign` only in that it always
// reads payload from `event.output.payload` — the compound is dispatching
// against the final substate's emitted `{ outcome, payload }` shape.
//
// `lift` here is the **parent** lift, because the compound's routes
// execute in the parent's scope (the compound's own context has already
// been torn down by `makeCompoundExit` by the time the parent's onDone
// fires).
function wrapCompoundExitAssign(
    userAssign: (args: {
        context: unknown;
        payload: unknown;
        deps: Readonly<Record<string, unknown>>;
    }) => object,
    parentLift: LiftContext | undefined,
    deps: Readonly<Record<string, unknown>>,
): AssignAction {
    if (parentLift !== undefined) {
        return wrapAssign(({ context, event }) => {
            const root = context as Record<string, unknown>;
            const sub = buildSubContext(root, parentLift);
            const output = (event as unknown as { output: { payload: unknown } }).output;
            return splitUserUpdateForParentLift(
                userAssign({ context: sub, payload: output.payload, deps }) as Record<string, unknown>,
                root,
                parentLift,
            );
        });
    }
    return wrapAssign(({ context, event }) => {
        const output = (event as unknown as { output: { payload: unknown } }).output;
        return userAssign({ context, payload: output.payload, deps });
    });
}

// Compound error entry → onDone[] transition. Differs from
// `wrapCompoundExitAssign` in that `error` is passed as a named argument
// (matching `ErrorEntry.assign`'s signature) and is read from
// `event.output.payload` (the error was hoisted by `$end_error`).
function wrapCompoundErrorAssign(
    userAssign: (args: {
        context: unknown;
        error: unknown;
        deps: Readonly<Record<string, unknown>>;
    }) => object,
    parentLift: LiftContext | undefined,
    deps: Readonly<Record<string, unknown>>,
): AssignAction {
    if (parentLift !== undefined) {
        return wrapAssign(({ context, event }) => {
            const root = context as Record<string, unknown>;
            const sub = buildSubContext(root, parentLift);
            const error = (event as unknown as { output: { payload: unknown } }).output.payload;
            return splitUserUpdateForParentLift(
                userAssign({ context: sub, error, deps }) as Record<string, unknown>,
                root,
                parentLift,
            );
        });
    }
    return wrapAssign(({ context, event }) => {
        const error = (event as unknown as { output: { payload: unknown } }).output.payload;
        return userAssign({ context, error, deps });
    });
}

// Mirrors `splitUserUpdate` in contextLift.ts but is private to compile.ts
// because the compound's exit/error assigns live here (not in
// buildActiveState). Keeping a slim duplicate avoids exporting the helper
// across module boundaries for one caller.
function splitUserUpdateForParentLift(
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
            if (owner.kind === "root") {
                rootPatch[k] = v;
            } else {
                touchSlot(owner.slotKey, k, v);
            }
            continue;
        }
    }

    for (const [slotKey, patch] of Object.entries(slotPatches)) {
        const current = (rootContext[slotKey] ?? {}) as Record<string, unknown>;
        rootPatch[slotKey] = { ...current, ...patch };
    }
    return rootPatch;
}

function normalizeExitEntries(
    entry: ExitEntry<InternalCtx, unknown> | RouteList<ExitEntry<InternalCtx, unknown>>,
): readonly ExitEntry<InternalCtx, unknown>[] {
    return isReadonlyArray(entry) ? entry : [entry];
}

function normalizeErrorEntries(
    entry: ErrorEntry<InternalCtx> | RouteList<ErrorEntry<InternalCtx>>,
): readonly ErrorEntry<InternalCtx>[] {
    return isReadonlyArray(entry) ? entry : [entry];
}

function bucketTargetForCompoundExit(
    target: ExitEntry<InternalCtx, unknown>["target"],
    outcomeKey: "achieved" | "abandoned",
): typeof target | EndBucketSymbol {
    if (target !== END) return target;
    return outcomeKey === "achieved" ? END_ACHIEVED : END_ABANDONED;
}

function buildCompoundExitOnDone(
    outcomeKey: "achieved" | "abandoned",
    entry: ExitEntry<InternalCtx, unknown>,
    parentLift: LiftContext | undefined,
    deps: Readonly<Record<string, unknown>>,
): LoweredOnDoneTransition {
    const transition: LoweredOnDoneTransition = {
        guard: makeCompoundOutcomeGuard(outcomeKey, entry.when),
        target: bucketTargetForCompoundExit(entry.target, outcomeKey),
    };
    if (entry.assign !== undefined) {
        transition.actions = wrapCompoundExitAssign(
            entry.assign as (args: {
                context: unknown;
                payload: unknown;
                deps: Readonly<Record<string, unknown>>;
            }) => object,
            parentLift,
            deps,
        );
    }
    return transition;
}

function buildCompoundErrorOnDone(
    entry: ErrorEntry<InternalCtx>,
    parentLift: LiftContext | undefined,
    deps: Readonly<Record<string, unknown>>,
): LoweredOnDoneTransition {
    const guard = makeCompoundOutcomeGuard("error", entry.when);

    if (entry.target === RE_THROW) {
        // Throw the error captured in event.output.payload. The user's
        // `assign` is dropped — same convention as the leaf RE_THROW path.
        return {
            guard,
            actions: wrapAssign(({ event }) => {
                throw (event as unknown as { output: { payload: unknown } }).output.payload;
            }),
        };
    }

    const transition: LoweredOnDoneTransition = {
        guard,
        target: entry.target === END ? END_ERROR : entry.target,
    };
    if (entry.assign !== undefined) {
        transition.actions = wrapCompoundErrorAssign(
            entry.assign as (args: {
                context: unknown;
                error: unknown;
                deps: Readonly<Record<string, unknown>>;
            }) => object,
            parentLift,
            deps,
        );
    }
    return transition;
}

function buildCompoundOnDone(
    routes: CompoundRoutesLoose,
    parentLift: LiftContext | undefined,
    deps: Readonly<Record<string, unknown>>,
): readonly LoweredOnDoneTransition[] {
    const out: LoweredOnDoneTransition[] = [];
    for (const entry of normalizeExitEntries(routes.achieved)) {
        out.push(buildCompoundExitOnDone("achieved", entry, parentLift, deps));
    }
    for (const entry of normalizeExitEntries(routes.abandoned)) {
        out.push(buildCompoundExitOnDone("abandoned", entry, parentLift, deps));
    }
    if (routes.error !== undefined) {
        for (const entry of normalizeErrorEntries(routes.error)) {
            out.push(buildCompoundErrorOnDone(entry, parentLift, deps));
        }
    }
    return out;
}

// ── Recursive mode-map lowering ──────────────────────────────────────

function joinPath(parent: string, name: string): string {
    return parent === "" ? name : `${parent}.${name}`;
}

// The child names in `modes` that lowered from `defineMode` (carrier
// `__kind === "leaf"`) — i.e. mini-compounds (SPEC 011). Used to scope the
// "omitted routes.error → re-throw" rewrite to leaf modes only.
function leafModeNamesOf(modes: Record<string, unknown>): ReadonlySet<string> {
    const out = new Set<string>();
    for (const [name, value] of Object.entries(modes)) {
        if (asCarrier(value).__kind === "leaf") out.add(name);
    }
    return out;
}

function buildStatesMap(
    modes: Record<string, unknown>,
    parentLift: LiftContext | undefined,
    parentPath: string,
    deps: Readonly<Record<string, unknown>>,
): Record<string, LoweredState> {
    const out: Record<string, LoweredState> = {};

    for (const [name, value] of Object.entries(modes)) {
        const path = joinPath(parentPath, name);
        const carrier = asCarrier(value);

        if (carrier.__kind === "leaf") {
            // SPEC 011 §Desugaring (DD-029): every leaf now has a `behavior` and
            // lowers to a mini-compound (`$run`/`$wait` + LOCAL `$end_*`). The
            // active/passive split is gone — `buildActiveState` discriminates on
            // `config.kind` (default "active") internally and returns a compound.
            const config = carrier.config;
            const slot: LeafSlot = { kind: "leaf", path, config };
            out[name] = buildActiveState(slot, parentLift, deps);
            continue;
        }

        // Compound.
        const cfg = carrier.config;

        let childLift: LiftContext | undefined = parentLift;
        let ownEntry: LoweredCompoundState["entry"];
        let ownExit: LoweredCompoundState["exit"];

        if (cfg.context !== undefined) {
            const ctx = cfg.context;
            const newLift: LiftContext = {
                key: compoundLocalKey(path),
                inherit: ctx.inherit,
                initialLocal: ctx.local,
                parent: parentLift,
            };
            childLift = newLift;
            ownEntry = makeCompoundEntry(newLift);
            ownExit = makeCompoundExit(newLift);
        }

        // 1. Lower the compound's children (with the compound-local lift if
        //    any). The children may contain bucket sentinels that need this
        //    compound's `$end_*` injection to resolve.
        const childStatesRaw = buildStatesMap(cfg.modes, childLift, path, deps);

        // 2. If this compound omits `routes.error`, child END references in
        //    `routes.error` must re-throw above this compound (spec 008
        //    line 87). Rewrite those transitions before the injection pass so
        //    the `error` bucket isn't injected as a final. Only LEAF children
        //    (now mini-compounds, SPEC 011) get the re-throw — track their
        //    names so real nested compounds keep their prior behavior.
        const childStatesAfterErrorFixup =
            cfg.routes.error === undefined
                ? rewriteErrorBucketAtLevel(childStatesRaw, leafModeNamesOf(cfg.modes))
                : childStatesRaw;

        // 3. Inject per-outcome `$end_*` finals. `outputCb` and `childLift`
        //    are this compound's own — the finals' `output` callbacks run
        //    inside this compound, with the compound-effective context view.
        const childStates = injectEndAtLevel(
            childStatesAfterErrorFixup,
            cfg.output,
            childLift,
            deps,
        );

        // 4. Build this compound's `onDone[]` from `cfg.routes`. Targets/
        //    assigns execute in the **parent** scope (after this compound
        //    exits), so use `parentLift` for the wrapping.
        const onDone = buildCompoundOnDone(cfg.routes, parentLift, deps);

        const compound: LoweredCompoundState = {
            initial: cfg.initial,
            states: childStates,
            onDone,
        };
        if (ownEntry !== undefined) compound.entry = ownEntry;
        if (ownExit !== undefined) compound.exit = ownExit;

        out[name] = compound;
    }

    return out;
}

// ── Public entry ─────────────────────────────────────────────────────

export function compile<
    TContext,
    TEvents extends { type: string },
    TModes extends ModesMap<TContext, TEvents, TDeps>,
    TDeps extends Record<string, unknown> = Record<string, never>,
>(
    config: AgentConfig<TContext, TEvents, TModes, TDeps>,
    frozenDeps: Readonly<TDeps>,
): CarrierMachine {
    const rawModes = config.modes as Record<string, unknown>;
    // Erase TDeps for the loose internal contract — every build* helper takes
    // `Readonly<Record<string, unknown>>` and the user's concrete type has
    // already been enforced at the call site.
    const deps = frozenDeps as Readonly<Record<string, unknown>>;

    // Fail-fast at machine creation — spec verification lines 821 + 824.
    validateTargets(rawModes);
    validateRoutes(rawModes);

    const slots = walk(rawModes);
    const actors = buildActors(slots, deps);
    const actions = buildActions(
        config.actions as Parameters<typeof buildActions>[0],
        deps,
    );

    const lowered = buildStatesMap(rawModes, undefined, "", deps);
    // Root-level injection: no enclosing compound → no `output?` callback,
    // no lift. Children that bubble END at the agent root land in
    // `$end_*` finals at the agent level (the actor reaches a top-level
    // final state).
    const finalStates = injectEndAtLevel(lowered, undefined, undefined, deps);

    // SPEC 012 §Seam 3: hand the lowered config to the backend, which owns the
    // `setup().createMachine` call and the `looseSetup` cast (the lowered shapes
    // are `unknown`-typed by construction — the user's concrete types were
    // discharged at the `defineAgent` call site).
    return createCarrier({
        actors,
        actions,
        machine: {
            id: config.id,
            initial: config.initial,
            context: config.context,
            states: finalStates,
        },
    });
}
