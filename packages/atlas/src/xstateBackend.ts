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
