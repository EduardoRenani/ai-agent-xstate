// `compile` — lowers an `AgentConfig` tree into a carrier machine.
//
// Spec: docs/specs/012-xstate-containment.md §Seam 3 (DD-033) + §P22.
//
// `compile` orchestrates the lowering but no longer touches the engine and no
// longer constructs engine-shaped config. It:
//   1. fails fast on invalid targets/routes (`validateTargets` / `validateRoutes`),
//   2. produces the carrier-neutral Atlas IR (`lowerToIr` → `IrAgent`,
//      src/ir.ts), and
//   3. hands that IR to `xstateBackend.translateAgent`, the ONE module that
//      knows the engine's config vocabulary (`$run`/`$wait` mini-compound,
//      `$end_*` final injection, `meta.atlasAwaiting`, the done/error event
//      reads, and the `looseSetup` cast).
//
// The previous direct config construction (the `buildStatesMap` /
// `buildCompoundOnDone` recursion + the leaf/compound route-lowering
// duplication, formerly in `buildActiveState.ts` / `injectEnd.ts`) is gone:
// both the leaf and the compound route lowering collapsed onto the IR's single
// `OutcomeEdge` / `ErrorEdge` shape, lowered once by the translator. Only the
// engine-neutral lift primitives survive in `contextLift.ts`.
//
// `defineAgent` returns this value verbatim.

import { lowerToIr } from "./lowerToIr.ts";
import type {
    AgentConfig,
    ModesMap,
} from "./types.ts";
import { translateAgent, type CarrierMachine } from "./xstateBackend.ts";
import { validateRoutes } from "./validateRoutes.ts";
import { validateTargets } from "./validateTargets.ts";

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
    // Erase TDeps for the loose internal contract — the IR producer takes
    // `Readonly<Record<string, unknown>>` and the user's concrete type has
    // already been enforced at the call site.
    const deps = frozenDeps as Readonly<Record<string, unknown>>;

    // Fail-fast at machine creation — spec verification lines 821 + 824.
    validateTargets(rawModes);
    validateRoutes(rawModes);

    // SPEC 012 §Seam 3: produce the Atlas IR, then hand it to the backend
    // translator. `lowerToIr` adapts every user callback into engine-neutral
    // `IrGuard` / `IrPatch` / `IrBehavior` shapes (closing over `deps`);
    // `translateAgent` owns the `setup().createMachine` synthesis + assembly.
    const looseConfig = config as unknown as AgentConfig<
        unknown,
        { type: string },
        ModesMap<unknown, { type: string }>
    >;
    const ir = lowerToIr(looseConfig, deps);
    return translateAgent(ir, deps);
}
