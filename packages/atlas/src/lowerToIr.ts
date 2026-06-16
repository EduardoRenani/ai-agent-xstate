// `lowerToIr` — produce the carrier-neutral `IrAgent` (src/ir.ts) from the
// `defineAgent` carrier tree.
//
// Spec: docs/specs/012-xstate-containment.md §Seam 3 (DD-033) + §P22.
//
// This module is the SINGLE producer of the Atlas-vocabulary IR. It walks the
// `modes` carrier tree, translating each user `Mode` / `CompoundMode` config
// into `ModeNode` / `CompoundNode`, and adapts every user callback
// (`routes.*.when`/`assign`, `stay.*.assign`, `input`, `output`) into the IR's
// engine-neutral `IrGuard` / `IrPatch` / `IrBehavior` shapes. `deps` is closed
// over here (the same frozen reference every callback receives).
//
// It speaks ONLY Atlas vocabulary — no `invoke`/`assign`/`reenter`/`meta`/`$`-
// names, and it does not import `xstate`. The translation of this IR into a
// `setup().createMachine` config lives exclusively in `xstateBackend.ts`
// (`translateAgent`), which `compile` calls with the IR this module produces.

import { actorName } from "./actorName.ts";
import { compoundLocalKey, type LiftContext } from "./contextLift.ts";
import { END, RE_THROW } from "./types.ts";
import type {
    AgentConfig,
    ErrorRouteTarget,
    ModesMap,
    RouteTarget,
} from "./types.ts";
import type {
    CompoundNode,
    ErrorEdge,
    IrAgent,
    IrBehavior,
    IrGuard,
    IrNode,
    IrPatch,
    IrTarget,
    ModeNode,
    OutcomeEdge,
} from "./ir.ts";

// ── Loose carrier shapes (runtime discriminator) ─────────────────────
//
// Mirrors compile.ts: the user's generic `TContext`/`TDeps` were discharged at
// the `defineMode` / `defineCompoundMode` call site; here we only read the
// runtime payload through `unknown`-typed callbacks. `deps` is typed as
// `Readonly<Record<string, unknown>>` (not the `Record<string, never>` default
// of `ExitEntry`/`ErrorEntry`), matching the loose internal contract every
// build* helper used — so re-declaring the entry shapes locally avoids the
// `as`-casts the legacy `buildFooExitTransition` needed at every call.

type LooseExitEntry = {
    readonly when?: (payload: unknown) => boolean;
    readonly target: RouteTarget;
    readonly assign?: (args: {
        context: unknown;
        payload: unknown;
        deps: Readonly<Record<string, unknown>>;
    }) => object;
};

type LooseErrorEntry = {
    readonly when?: (error: unknown) => boolean;
    readonly target: ErrorRouteTarget;
    readonly assign?: (args: {
        context: unknown;
        error: unknown;
        deps: Readonly<Record<string, unknown>>;
    }) => object;
};

type LooseStayEntry = {
    readonly assign?: (args: {
        context: unknown;
        payload: unknown;
        deps: Readonly<Record<string, unknown>>;
    }) => object;
};

type LooseRoutes = {
    readonly achieved: LooseExitEntry | readonly LooseExitEntry[];
    readonly abandoned: LooseExitEntry | readonly LooseExitEntry[];
    readonly error?: LooseErrorEntry | readonly LooseErrorEntry[];
};

type LooseStayMap = {
    readonly replay?: LooseStayEntry;
    readonly waitOnEvent?: LooseStayEntry;
};

type LooseLeafConfig = {
    readonly start?: "run" | "event";
    readonly input: (args: {
        context: unknown;
        deps: Readonly<Record<string, unknown>>;
    }) => unknown;
    readonly events?: readonly string[];
    readonly routes: LooseRoutes;
    readonly stay?: LooseStayMap;
    readonly behavior: IrBehavior;
};

type LooseCompoundConfig = {
    readonly initial: string;
    readonly modes: Record<string, unknown>;
    readonly routes: LooseRoutes;
    readonly output?: (args: {
        context: unknown;
        deps: Readonly<Record<string, unknown>>;
    }) => unknown;
    readonly context?: {
        readonly inherit: readonly string[];
        readonly local: Readonly<Record<string, unknown>>;
    };
};

type LeafCarrier = { readonly __kind: "leaf"; readonly config: LooseLeafConfig };
type CompoundCarrier = { readonly __kind: "compound"; readonly config: LooseCompoundConfig };

function asCarrier(value: unknown): LeafCarrier | CompoundCarrier {
    return value as LeafCarrier | CompoundCarrier;
}

function isReadonlyArray<T>(value: T | readonly T[]): value is readonly T[] {
    return Array.isArray(value);
}

function normalizeExitEntries(
    entry: LooseExitEntry | readonly LooseExitEntry[],
): readonly LooseExitEntry[] {
    return isReadonlyArray(entry) ? entry : [entry];
}

function normalizeErrorEntries(
    entry: LooseErrorEntry | readonly LooseErrorEntry[],
): readonly LooseErrorEntry[] {
    return isReadonlyArray(entry) ? entry : [entry];
}

// ── Callback adapters (user → IR vocabulary) ─────────────────────────

// A user `when(payload)` → IR `(payload, _context) => boolean`. The IR guard's
// `context` arg is unused for outcome dispatch (the matched payload is the
// decision input — mirrors the legacy `makeFooOutcomeGuard`/`makeCompoundOutcome-
// Guard`, both of which only read `out.payload`).
function adaptGuard(
    userWhen: ((payload: unknown) => boolean) | undefined,
): IrGuard | undefined {
    if (userWhen === undefined) return undefined;
    return (payload) => userWhen(payload);
}

// A user exit/stay `assign({ context, payload, deps })` → IR `(context, event)`
// where `event` is the matched payload. `deps` is closed over (the frozen
// reference threaded from `defineAgent`).
function adaptExitPatch(
    userAssign:
        | ((args: {
              context: unknown;
              payload: unknown;
              deps: Readonly<Record<string, unknown>>;
          }) => object)
        | undefined,
    deps: Readonly<Record<string, unknown>>,
): IrPatch | undefined {
    if (userAssign === undefined) return undefined;
    return (context, event) => userAssign({ context, payload: event, deps });
}

// A user error `assign({ context, error, deps })` → IR `(context, event)` where
// `event` is the raw error.
function adaptErrorPatch(
    userAssign:
        | ((args: {
              context: unknown;
              error: unknown;
              deps: Readonly<Record<string, unknown>>;
          }) => object)
        | undefined,
    deps: Readonly<Record<string, unknown>>,
): IrPatch | undefined {
    if (userAssign === undefined) return undefined;
    return (context, event) => userAssign({ context, error: event, deps });
}

// ── routes → OutcomeEdge[] / ErrorEdge[] ─────────────────────────────

function exitEdge(
    bucket: "achieved" | "abandoned",
    entry: LooseExitEntry,
    deps: Readonly<Record<string, unknown>>,
): OutcomeEdge {
    // `target: END` leaves THIS scope via the bucket; a sibling name routes to
    // a sibling state.
    const target: IrTarget =
        entry.target === END
            ? { kind: "end", bucket }
            : { kind: "state", name: entry.target as string };
    const edge: OutcomeEdge = { bucket, target };
    const guard = adaptGuard(entry.when);
    if (guard !== undefined) edge.guard = guard;
    const patch = adaptExitPatch(entry.assign, deps);
    if (patch !== undefined) edge.patch = patch;
    return edge;
}

function errorEdge(
    entry: LooseErrorEntry,
    deps: Readonly<Record<string, unknown>>,
): ErrorEdge {
    // `RE_THROW` → first-class abort; `END` → leave via the error bucket; a
    // sibling name routes to a sibling state.
    const target: IrTarget =
        entry.target === RE_THROW
            ? { kind: "abort" }
            : entry.target === END
              ? { kind: "end", bucket: "error" }
              : { kind: "state", name: entry.target as string };
    const edge: ErrorEdge = { target };
    const guard = adaptGuard(entry.when);
    if (guard !== undefined) edge.guard = guard;
    // The translator drops the patch when the target is abort; carrying it is
    // harmless and matches the IR contract.
    const patch = adaptErrorPatch(entry.assign, deps);
    if (patch !== undefined) edge.patch = patch;
    return edge;
}

function buildExitEdges(
    routes: LooseRoutes,
    deps: Readonly<Record<string, unknown>>,
): readonly OutcomeEdge[] {
    const out: OutcomeEdge[] = [];
    for (const entry of normalizeExitEntries(routes.achieved)) {
        out.push(exitEdge("achieved", entry, deps));
    }
    for (const entry of normalizeExitEntries(routes.abandoned)) {
        out.push(exitEdge("abandoned", entry, deps));
    }
    return out;
}

function buildErrorEdges(
    routes: LooseRoutes,
    deps: Readonly<Record<string, unknown>>,
): readonly ErrorEdge[] {
    if (routes.error === undefined) return [];
    return normalizeErrorEntries(routes.error).map((entry) => errorEdge(entry, deps));
}

// ── stay → replay / waitOnEvent ──────────────────────────────────────

function stayContinuation(
    entry: LooseStayEntry,
    deps: Readonly<Record<string, unknown>>,
): { patch?: IrPatch } {
    const patch = adaptExitPatch(entry.assign, deps);
    return patch === undefined ? {} : { patch };
}

// ── Leaf mode → ModeNode ─────────────────────────────────────────────

function lowerLeaf(
    config: LooseLeafConfig,
    path: string,
    deps: Readonly<Record<string, unknown>>,
): ModeNode {
    const routes = config.routes;
    const stay = config.stay;

    const node: ModeNode = {
        kind: "mode",
        // `start:"event"` parks on entry; `start:"run"` (default) runs immediately.
        startsParked: config.start === "event",
        behavior: config.behavior,
        awaitedEvents: config.events ?? [],
        actorName: actorName(path),
        input: ({ context, deps: d }) => config.input({ context, deps: d }),
        exits: buildExitEdges(routes, deps),
        errors: buildErrorEdges(routes, deps),
    };

    if (stay?.replay !== undefined) {
        node.replay = stayContinuation(stay.replay, deps);
    }
    if (stay?.waitOnEvent !== undefined) {
        node.waitOnEvent = stayContinuation(stay.waitOnEvent, deps);
    }

    return node;
}

// ── Compound → CompoundNode ──────────────────────────────────────────

function lowerCompound(
    config: LooseCompoundConfig,
    path: string,
    parentLift: LiftContext | undefined,
    deps: Readonly<Record<string, unknown>>,
): CompoundNode {
    // A compound with `context: { inherit, local }` allocates its own lift
    // (slot + entry/exit). The lift carries the parent reference so nested
    // inherit reads/writes resolve up the chain (mirrors compile.buildStatesMap).
    let ownLift: LiftContext | undefined;
    if (config.context !== undefined) {
        ownLift = {
            key: compoundLocalKey(path),
            inherit: config.context.inherit,
            initialLocal: config.context.local,
            parent: parentLift,
        };
    }
    const childLift = ownLift ?? parentLift;

    const node: CompoundNode = {
        kind: "compound",
        initial: config.initial,
        children: lowerChildren(config.modes, childLift, path, deps),
        exits: buildExitEdges(config.routes, deps),
        errors: buildErrorEdges(config.routes, deps),
        // Drives the "omitted routes.error → re-throw above this compound"
        // rewrite in the translator (the spec-005 loud-failure default).
        errorOmitted: config.routes.error === undefined,
    };
    if (config.output !== undefined) {
        const output = config.output;
        node.output = ({ context, deps: d }) => output({ context, deps: d });
    }
    if (ownLift !== undefined) node.contextLift = ownLift;
    return node;
}

function joinPath(parent: string, name: string): string {
    return parent === "" ? name : `${parent}.${name}`;
}

function lowerChildren(
    modes: Record<string, unknown>,
    parentLift: LiftContext | undefined,
    parentPath: string,
    deps: Readonly<Record<string, unknown>>,
): Record<string, IrNode> {
    const out: Record<string, IrNode> = {};
    for (const [name, value] of Object.entries(modes)) {
        const path = joinPath(parentPath, name);
        const carrier = asCarrier(value);
        if (carrier.__kind === "leaf") {
            const config = carrier.config;
            if (!("behavior" in config)) {
                throw new Error(`atlas/lowerToIr: leaf at "${path}" has no behavior`);
            }
            const leaf = lowerLeaf(config, path, deps);
            // A leaf's exits/errors lower against its OWN lift (the enclosing
            // compound's child-lift), so the patch split writes into the right
            // slot. Carry it on the node (the translator reads node.contextLift).
            if (parentLift !== undefined) leaf.contextLift = parentLift;
            out[name] = leaf;
        } else {
            out[name] = lowerCompound(carrier.config, path, parentLift, deps);
        }
    }
    return out;
}

// ── Actor registry: name → raw behavior ──────────────────────────────
//
// The translator wraps each behavior in the carrier promise-actor with the
// `{ userInput, event }` envelope. Here we only collect the Atlas-neutral
// behaviors keyed by `actorName(path)` — identical key set to `buildActors`.
function collectActors(
    modes: Record<string, unknown>,
    parentPath: string,
    out: Record<string, IrBehavior>,
): void {
    for (const [name, value] of Object.entries(modes)) {
        const path = joinPath(parentPath, name);
        const carrier = asCarrier(value);
        if (carrier.__kind === "leaf") {
            const config = carrier.config;
            if (!("behavior" in config)) continue;
            const key = actorName(path);
            if (key in out) {
                throw new Error(
                    `atlas/lowerToIr: duplicate actor name "${key}" at path "${path}"`,
                );
            }
            out[key] = config.behavior;
        } else {
            collectActors(carrier.config.modes, path, out);
        }
    }
}

// ── Public entry ─────────────────────────────────────────────────────

export function lowerToIr(
    config: AgentConfig<unknown, { type: string }, ModesMap<unknown, { type: string }>>,
    deps: Readonly<Record<string, unknown>>,
): IrAgent {
    const rawModes = config.modes as Record<string, unknown>;

    const actors: Record<string, IrBehavior> = {};
    collectActors(rawModes, "", actors);

    // Named actions: the user's `({ context, event, deps }) => Partial` callbacks,
    // closed over `deps`. The translator wraps each in the carrier `assign`.
    const namedActions: IrAgent["namedActions"] = {};
    const userActions = config.actions as
        | Readonly<
              Record<
                  string,
                  (args: {
                      context: unknown;
                      event: { type: string };
                      deps: Readonly<Record<string, unknown>>;
                  }) => object
              >
          >
        | undefined;
    if (userActions !== undefined) {
        for (const [name, cb] of Object.entries(userActions)) {
            namedActions[name] = ({ context, event, deps: d }) =>
                cb({ context, event, deps: d });
        }
    }

    return {
        id: config.id,
        initial: config.initial,
        context: config.context,
        children: lowerChildren(rawModes, undefined, "", deps),
        actors,
        namedActions,
    };
}
