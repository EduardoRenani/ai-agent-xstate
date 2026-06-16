// ── src/ir.ts — Atlas-vocabulary IR. NO xstate import. NO invoke/assign/reenter/meta/$-names. ──
//
// Spec: docs/specs/012-xstate-containment.md §Seam 3 (DD-033) + §P22.
//
// This module defines the carrier-neutral intermediate representation that the
// lowering pipeline produces and that `xstateBackend` consumes. It speaks only
// Atlas vocabulary: modes, compounds, outcome/error edges, guards, patches, and
// the three first-class edge destinations (sibling state, end-via-bucket, abort).
//
// Hard boundary: this file MUST NOT import the xstate package and MUST NOT contain
// any XState config vocabulary — no `invoke`, `assign`, `reenter`, `meta`, or
// `$`-prefixed state names. Those concepts live exclusively in `xstateBackend.ts`,
// which translates this IR into a `setup().createMachine` config.
//
// The IR boundary sits ABOVE the per-mode lowering: `lowerToIr` walks the
// `AgentConfig` tree and emits this carrier-neutral IR, and `xstateBackend`'s
// translator turns it into the `$run`/`$wait` mini-compound, `$end_*` finals,
// and engine event reads. No XState-shaped `Lowered*` config exists outside the
// translator anymore — the IR is the single contract between the two halves.

// EndBucket already exists in endBuckets.ts — reuse it (it is Atlas vocabulary, no $).
import type { EndBucket } from "./endBuckets.ts";

// LiftContext stays an Atlas concept carried opaquely through the IR (it holds no
// XState; the translator threads it into entry/exit slot synthesis).
import type { LiftContext } from "./contextLift.ts";

// END/RE_THROW are already Atlas vocabulary in types.ts. They are re-exported here
// so IR producers and the translator share the public symbols; RE_THROW is the
// conceptual source of the first-class `abort` instruction.
import type { END, RE_THROW } from "./types.ts";
export type { END, RE_THROW };

// Guards: (payload, context) => boolean — payload-only/outcome dispatch lives in the
// translator; the IR guard is the USER-facing predicate over the matched payload.
export type IrGuard = (payload: unknown, context: unknown) => boolean;

// Patches: (context, event) => Partial<context>. `event` is the Atlas waking-event
// value (the event-slot content), NOT an xstate event. The translator adapts the
// argument shape.
export type IrPatch = (context: unknown, event: unknown) => object;

// Behavior envelope, engine-neutral. The translator wraps it in fromPromiseActor and
// supplies the {userInput,event} input envelope.
export type IrBehavior = (args: {
    input: unknown;
    event: unknown;
    deps: Readonly<Record<string, unknown>>;
}) => Promise<unknown>;

// Where an edge sends control once matched. Three first-class destinations —
// no $-prefixed names, no sentinels leaking. `end` reuses the bucket vocabulary
// (was END + sentinel); `abort` is the re-throw instruction (was RE_THROW /
// the throw smuggled inside an action).
export type IrTarget =
    | { kind: "state"; name: string }    // sibling state name (translator resolves)
    | { kind: "end"; bucket: EndBucket } // leave this scope via bucket (was END + sentinel)
    | { kind: "abort" };                 // re-throw above the scope (was RE_THROW / smuggled throw)

// One exit edge (achieved/abandoned). Replaces the leaf `buildFooExitTransition`
// and the compound `buildCompoundExitOnDone` — they collapse to this one shape.
export type OutcomeEdge = {
    bucket: "achieved" | "abandoned";
    guard?: IrGuard;          // user `when(payload)`; absent => always
    patch?: IrPatch;          // user `assign` -> Partial<context>; absent => no write
    target: IrTarget;         // {state}|{end} (never {abort})
};

// One error edge. Replaces the leaf `buildFooErrorTransition`, the compound
// `buildCompoundErrorOnDone`, and the RE_THROW branches. `target.kind:"abort"` IS
// the first-class re-throw.
export type ErrorEdge = {
    guard?: IrGuard;          // user `when(error)`; payload arg carries the error
    patch?: IrPatch;          // dropped by the translator when target is abort (existing convention)
    target: IrTarget;         // {state}|{end}|{abort}
};

// A leaf mode. `startsParked` = (start === "event"); `awaitedEvents` = events list.
// `contextLift` is the OPAQUE LiftContext (an Atlas concept carrying no xstate).
export type ModeNode = {
    kind: "mode";
    startsParked: boolean;
    behavior: IrBehavior;
    awaitedEvents: readonly string[];
    actorName: string;                  // registry key; minted by actorName(path)
    input: (args: { context: unknown; deps: Readonly<Record<string, unknown>> }) => unknown;
    // STAY continuations — Atlas vocabulary, no $run/$wait:
    replay?: { patch?: IrPatch };       // re-run now; translator decides clear-vs-keep event slot
    waitOnEvent?: { patch?: IrPatch };  // re-run on next event
    exits: readonly OutcomeEdge[];      // routes.achieved/abandoned (foo.onDone scope)
    errors: readonly ErrorEdge[];       // routes.error (foo.onDone scope after the error hop)
    contextLift?: LiftContext;
};

// A compound. `children` is name->node. `output` shapes the bucket payload.
export type CompoundNode = {
    kind: "compound";
    initial: string;
    children: Record<string, IrNode>;
    exits: readonly OutcomeEdge[];      // cfg.routes.achieved/abandoned
    errors: readonly ErrorEdge[];       // cfg.routes.error (empty => omitted => abort default)
    errorOmitted: boolean;              // drives the "omitted routes.error -> abort" rewrite
    output?: (args: { context: unknown; deps: Readonly<Record<string, unknown>> }) => unknown;
    contextLift?: LiftContext;          // this compound's own lift (entry/exit slot)
};

export type IrNode = ModeNode | CompoundNode;

// The whole machine, pre-translation.
export type IrAgent = {
    id: string;
    initial: string;
    context: unknown;
    children: Record<string, IrNode>;   // root level
    actors: Record<string, IrBehavior>; // actor registry (name -> behavior), Atlas-neutral
    namedActions: Record<string, (args: {
        context: unknown; event: { type: string }; deps: Readonly<Record<string, unknown>>;
    }) => object>;
};
