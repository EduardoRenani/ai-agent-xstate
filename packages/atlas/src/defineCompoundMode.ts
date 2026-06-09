// `defineCompoundMode` — constructs a CompoundMode (a Mode with sub-Modes).
//
// Spec: docs/specs/004-xstate-agent-wrapper.md §`defineCompoundMode`
//        + docs/specs/005-agent-deps-and-stringifiable-context.md §`defineCompoundMode`
//        + docs/specs/006-modes-not-states.md §"Refined vocabulary"
//
// Like `defineMode`, this is a thin Phase 3 shell. The generics enforce
// the compound-local context narrowing at the call site: children's
// `TContext` is `LocalContextOf<TParentContext, TCtx>`. The compile step in
// `compile.ts` lowers the carrier to XState states later.
//
// `TDeps` is threaded through to the returned `CompoundMode` brand via its
// contravariant `__phantomDeps` field. See spec 005 §`defineCompoundMode` for
// the manual-threading rationale: TypeScript cannot infer the agent's `TDeps`
// from a sub-Mode definition site (Modes are typically declared in separate
// files and only referenced from `defineAgent.modes`), so each
// `defineCompoundMode` invocation declares its own `TDeps` generic explicitly.

import type {
    CompoundContext,
    CompoundMode,
    CompoundModeConfig,
    LocalContextOf,
    ModesMap,
} from "./types.ts";

/**
 * Runtime carrier behind the opaque `CompoundMode` brand. Internal —
 * accessed only by `compile.ts` via the `__kind` discriminant.
 *
 * `config` is stored as `unknown` on purpose: the original generic narrowing
 * has already done its job at the call site, and `compile.ts` walks the tree
 * structurally rather than relying on the generic parameters.
 *
 * @template TParentContext  Context shape the parent scope provides.
 * @template TEvents         The agent's full event union.
 * @template TPayload        Payload type produced by the compound's `output?`
 *                           callback (DD-025).
 * @template TDeps           Frozen deps container this compound demands.
 */
export type CompoundModeCarrier<
    TParentContext,
    TEvents extends { type: string },
    TPayload = unknown,
    TDeps extends Record<string, unknown> = Record<string, never>,
> = {
    readonly __kind: "compound";
    readonly config: unknown;
};

/**
 * Construct a **CompoundMode** — a Mode that contains sub-Modes. Use this to
 * group related leaves under a shared lifecycle, optionally narrowing the
 * context children see via `context: { inherit, local }`.
 *
 * Children's effective context is `LocalContextOf<TParentContext, TCtx>`:
 * - With `context` supplied: `Pick<TParentContext, inherit[number]> & typeof local`.
 *   Inherited keys are live-mirrored; locals are reset on every re-entry, but
 *   **NOT** on snapshot restore — when an actor is rehydrated via
 *   `startAgent({ snapshot })`, the persisted slot wins over the entry-reset
 *   (spec 009 §Persistence Contract).
 * - Without `context`: children see the full `TParentContext`.
 *
 * Children route out of the compound via `END` (defined in `./types.ts`); the
 * compound's `routes` then fire the parent-level transition. The compound's
 * outcome bucket is whichever bucket of the exiting child contained
 * `target: END` (DD-025, spec 008 §"Outcome propagation rules").
 *
 * @template TParentContext  The context the enclosing scope provides to this
 *                           compound. Constrained to
 *                           `JsonCompatible<TParentContext>`.
 * @template TEvents         The agent's full event union (each variant has a
 *                           `type` discriminant).
 * @template TCtx            Either `undefined` (no narrowing — children see
 *                           `TParentContext`) or a `CompoundContext` literal
 *                           declaring which keys to `inherit` and which `local`
 *                           variables to declare. The `local` shape must
 *                           satisfy `JsonCompatible<TLocal>` (enforced at the
 *                           `CompoundContext` alias level).
 * @template TModes          The compound's `modes` map. Each slot is a
 *                           `Mode` (leaf) or nested `CompoundMode` typed
 *                           against the compound-local context view.
 * @template TPayload        Payload type produced by the compound's optional
 *                           `output?` callback (DD-025). Defaults to
 *                           `undefined` — when `output` is omitted, the
 *                           compound emits payload `undefined` to its parent.
 * @template TDeps           Frozen deps this compound passes to its children.
 *                           Must match the agent's `TDeps` at the slot site
 *                           (spec 005 §`defineCompoundMode` "Manual threading").
 *
 * @param config  `{ context?, initial, modes, output?, routes }`. `initial` is
 *                keyed against `TModes` so a typo is a compile error. `routes`
 *                takes the same four-key shape as `Mode.routes`; the compound's
 *                outcome bucket is whichever bucket of the exiting child
 *                contained `target: END`.
 *
 * @returns An opaque `CompoundMode` brand. Only `defineCompoundMode` /
 *          `defineAgent` accept it as a `modes` slot.
 *
 * @example CompoundMode with context narrowing — children see only `messages`.
 * ```ts
 * const socratic = defineCompoundMode<AgentCtx, Ev, {
 *     inherit: ["messages"];
 *     local: { attempts: number };
 * }, {
 *     thinking: Mode<{ messages: Msg[]; attempts: number }, Ev>;
 *     evaluating: Mode<{ messages: Msg[]; attempts: number }, Ev, EvalPayload>;
 * }, undefined, AgentDeps>({
 *     context: { inherit: ["messages"] as const, local: { attempts: 0 } },
 *     initial: "thinking",
 *     modes: { thinking, evaluating },
 *     routes: {
 *         achieved:  { target: "listening" },
 *         abandoned: { target: "listening" },
 *     },
 * });
 * ```
 */
export function defineCompoundMode<
    TParentContext,
    TEvents extends { type: string },
    TCtx extends
        | CompoundContext<
            TParentContext,
            ReadonlyArray<keyof TParentContext & string>,
            // The alias-level `JsonCompatible<TLocal>` bound does the
            // real serializability check against the user's concrete shape
            // (e.g. `{ attempts: number }`). Here we only need a structural
            // upper bound — `object` admits the user's literal shape while
            // satisfying the alias's `TLocal extends JsonCompatible<TLocal>`
            // constraint (`JsonCompatible<object>` reduces to `{}`).
            object
        >
        | undefined,
    TModes extends ModesMap<LocalContextOf<TParentContext, TCtx>, TEvents, TDeps>,
    TPayload = undefined,
    TDeps extends Record<string, unknown> = Record<string, never>,
>(
    config: CompoundModeConfig<TParentContext, TEvents, TCtx, TModes, TPayload, TDeps>,
): CompoundMode<TParentContext, TEvents, TPayload, TDeps> {
    const carrier: CompoundModeCarrier<TParentContext, TEvents, TPayload, TDeps> = {
        __kind: "compound",
        config,
    };
    return carrier as unknown as CompoundMode<TParentContext, TEvents, TPayload, TDeps>;
}
