// `compile` — lowers an `AgentConfig` tree into an XState machine.
//
// Spec: docs/specs/004-xstate-agent-wrapper.md §"Wrapper internals (compile.ts)"
// + §Mapping. Tasks: docs/specs/004-tasks.md Phase 5.16 (final emit).
// Spec 005: closes over a frozen `deps` reference and threads it to every
//           build* helper. `deps` is NOT placed in XState context — it lives
//           in callback closures, so `JSON.stringify(actor.getSnapshot().context)`
//           returns only TContext (+ synthetic compound-local slots).
//
// This is the only file in `atlas` that calls `setup().createMachine`. It
// composes the toolkit slices built in 5.1–5.15:
//   - validateTargets, validateRoutes   (fail-fast at machine creation)
//   - walk + actorName + buildActors    (active-leaf actor map)
//   - buildActions                      (named-actions map)
//   - buildActiveState / buildPassiveState (per-leaf lowering, lift-aware)
//   - contextLift (LiftContext + entry/exit on compounds that declare context)
//   - injectEnd (per-level `$end` substate + END → name rewrite)
//
// `defineAgent` returns this value verbatim.

import { setup, type AnyActorLogic, type AnyStateMachine, type assign as XAssign } from "xstate";

import { buildActions } from "./buildActions.ts";
import { buildActiveState, type LoweredInvokeState } from "./buildActiveState.ts";
import { buildActors } from "./buildActors.ts";
import { buildPassiveState, type LoweredAtomicState } from "./buildPassiveState.ts";
import {
    compoundLocalKey,
    makeCompoundEntry,
    makeCompoundExit,
    type LiftContext,
} from "./contextLift.ts";
import {
    END_SUBSTATE,
    hasEndReference,
    pickEndName,
    rewriteEndTargets,
} from "./injectEnd.ts";
import { END } from "./types.ts";
import type {
    AgentConfig,
    JsonObject,
    LeafModeConfig,
    ModesMap,
    PassiveLeafModeConfig,
    RouteTarget,
} from "./types.ts";
import { validateRoutes } from "./validateRoutes.ts";
import { validateTargets } from "./validateTargets.ts";
import { walk, type LeafSlot } from "./walk.ts";

// ── Internal lowered shapes ──────────────────────────────────────────

type LoweredLeafState = LoweredInvokeState | LoweredAtomicState;

type LoweredFinalState = { readonly type: "final" };

type LoweredCompoundState = {
    initial: string;
    states: Record<string, LoweredState>;
    onDone?: { target: RouteTarget }; // END target rewritten by parent level
    entry?: ReturnType<typeof XAssign>;
    exit?: ReturnType<typeof XAssign>;
};

type LoweredState = LoweredLeafState | LoweredCompoundState | LoweredFinalState;

// ── Carrier shapes (runtime discriminator) ───────────────────────────
//
// Re-declared as loose runtime shapes — the user's generic types have done
// their job at the call site (defineLeafMode / defineMode). The walk layer
// only reads the runtime payload.

// The internal "loose" placeholder for TContext at the carrier layer. The
// type system has already enforced `JsonCompatible<TContext>` at the user's
// `defineLeafMode` / `defineMode` / `defineAgent` call site; here we only
// need a structural pass-through that itself satisfies the JSON constraint
// so the alias references compile. `JsonObject` is a self-referential JSON
// shape (its value type is `JsonValue`), which is the loosest such anchor.
type InternalCtx = JsonObject;

type LeafCarrier = {
    readonly __kind: "leaf";
    readonly config: LeafModeConfig<InternalCtx, { type: string }, unknown>;
};
type CompoundCarrier = {
    readonly __kind: "compound";
    readonly config: {
        readonly initial: string;
        readonly modes: Record<string, unknown>;
        readonly onDone: RouteTarget;
        readonly context?: {
            readonly inherit: readonly string[];
            readonly local: Readonly<Record<string, unknown>>;
        };
    };
};

function asCarrier(value: unknown): LeafCarrier | CompoundCarrier {
    return value as LeafCarrier | CompoundCarrier;
}

// ── END detection / rewriting at a level ─────────────────────────────

function isCompound(node: LoweredState): node is LoweredCompoundState {
    return "initial" in node && "states" in node;
}

function isFinal(node: LoweredState): node is LoweredFinalState {
    return "type" in node && node.type === "final";
}

function nodeExitsViaEnd(node: LoweredState): boolean {
    if (isFinal(node)) return false;
    if (isCompound(node)) {
        return node.onDone !== undefined && node.onDone.target === END;
    }
    return hasEndReference(node);
}

function rewriteNodeEnd(node: LoweredState, endName: string): LoweredState {
    if (isFinal(node)) return node;
    if (isCompound(node)) {
        if (node.onDone !== undefined && node.onDone.target === END) {
            return { ...node, onDone: { target: endName } };
        }
        return node;
    }
    return rewriteEndTargets(node, endName);
}

function injectEndAtLevel(
    states: Record<string, LoweredState>,
): Record<string, LoweredState> {
    let anyEnd = false;
    for (const node of Object.values(states)) {
        if (nodeExitsViaEnd(node)) {
            anyEnd = true;
            break;
        }
    }
    if (!anyEnd) return states;

    const endName = pickEndName(Object.keys(states));
    const rewritten: Record<string, LoweredState> = {};
    for (const [name, node] of Object.entries(states)) {
        rewritten[name] = rewriteNodeEnd(node, endName);
    }
    rewritten[endName] = END_SUBSTATE;
    return rewritten;
}

// ── Recursive mode-map lowering ──────────────────────────────────────

function joinPath(parent: string, name: string): string {
    return parent === "" ? name : `${parent}.${name}`;
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
            const config = carrier.config;
            if ("behavior" in config && config.behavior !== undefined) {
                const slot: LeafSlot = { kind: "leaf", path, config };
                out[name] = buildActiveState(slot, parentLift, deps);
            } else {
                out[name] = buildPassiveState(
                    config as PassiveLeafModeConfig<InternalCtx, { type: string }>,
                    parentLift,
                    deps,
                );
            }
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

        const childStatesRaw = buildStatesMap(cfg.modes, childLift, path, deps);
        const childStates = injectEndAtLevel(childStatesRaw);

        const compound: LoweredCompoundState = {
            initial: cfg.initial,
            states: childStates,
            onDone: { target: cfg.onDone },
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
): AnyStateMachine {
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
    const finalStates = injectEndAtLevel(lowered);

    // The wrapper's type contract was discharged at the user's call site
    // (defineLeafMode / defineMode / defineAgent). At this internal layer
    // every shape is `unknown`-typed by construction. XState's `setup` types
    // are too strict to satisfy generically — its `MachineContext` constraint
    // collides with `TContext` being arbitrary — so we hand it the already-
    // shaped values through `unknown`. The output is `AnyStateMachine`, which
    // is what `defineAgent` returns.
    const looseSetup = setup as unknown as (args: {
        types?: unknown;
        actors?: Record<string, AnyActorLogic>;
        actions?: Record<string, unknown>;
    }) => { createMachine: (config: unknown) => AnyStateMachine };

    const machine = looseSetup({
        actors,
        actions,
    }).createMachine({
        id: config.id,
        initial: config.initial,
        context: config.context,
        states: finalStates,
    });

    return machine;
}
