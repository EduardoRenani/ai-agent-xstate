// `defineMode` — constructs a compound mode (a state with substates).
//
// Spec: docs/specs/004-xstate-agent-wrapper.md §`defineMode`
//        + docs/specs/005-agent-deps-and-stringifiable-context.md §`defineMode`.
//
// Like `defineLeafMode`, this is a thin Phase 3 shell. The generics enforce
// the compound-local context narrowing at the call site: children's
// `TContext` is `LocalContextOf<TParentContext, TCtx>`. The compile step in
// `compile.ts` lowers the carrier to XState states later.
//
// `TDeps` is threaded through to the returned `Mode` brand via its
// contravariant `__phantomDeps` field. See spec 005 §`defineMode` for the
// manual-threading rationale: TypeScript cannot infer the agent's `TDeps`
// from a sub-mode definition site (modes are typically declared in separate
// files and only referenced from `defineAgent.modes`), so each `defineMode`
// invocation declares its own `TDeps` generic explicitly.

import type {
    CompoundContext,
    LocalContextOf,
    Mode,
    ModeConfig,
    ModesMap,
} from "./types.ts";

/**
 * Runtime carrier behind the opaque `Mode` brand. Internal — accessed only
 * by `compile.ts` via the `__kind` discriminant.
 *
 * `config` is stored as `unknown` on purpose: the original generic narrowing
 * has already done its job at the call site, and `compile.ts` walks the tree
 * structurally rather than relying on the generic parameters.
 *
 * @template TParentContext  Context shape the parent scope provides.
 * @template TEvents         The agent's full event union.
 * @template TDeps           Frozen deps container this compound demands.
 */
export type ModeCarrier<
    TParentContext,
    TEvents extends { type: string },
    TDeps extends Record<string, unknown> = Record<string, never>,
> = {
    readonly __kind: "compound";
    readonly config: unknown;
};

/**
 * Construct a **compound mode** — a state that contains sub-states. Use this
 * to group related leaves under a shared lifecycle, optionally narrowing the
 * context children see via `context: { inherit, local }`.
 *
 * Children's effective context is `LocalContextOf<TParentContext, TCtx>`:
 * - With `context` supplied: `Pick<TParentContext, inherit[number]> & typeof local`.
 *   Inherited keys are live-mirrored; locals are reset on every entry.
 * - Without `context`: children see the full `TParentContext`.
 *
 * Children route out of the compound via `END` (defined in `./types.ts`); the
 * compound's `onDone` then fires the parent-level transition.
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
 *                           `LeafMode` or nested `Mode` typed against the
 *                           compound-local context view.
 * @template TDeps           Frozen deps this compound passes to its children.
 *                           Must match the agent's `TDeps` at the slot site
 *                           (spec 005 §`defineMode` "Manual threading").
 *
 * @param config  `{ context?, initial, modes, onDone }`. `initial` is keyed
 *                against `TModes` so a typo is a compile error. `onDone`
 *                accepts a sibling name or `END` (when nested further).
 *
 * @returns An opaque `Mode` brand. Only `defineMode` / `defineAgent` accept it
 *          as a `modes` slot.
 *
 * @example Compound with context narrowing — children see only `messages`.
 * ```ts
 * const socratic = defineMode<AgentCtx, Ev, {
 *     inherit: ["messages"];
 *     local: { attempts: number };
 * }, {
 *     thinking: LeafMode<{ messages: Msg[]; attempts: number }, Ev>;
 *     evaluating: LeafMode<{ messages: Msg[]; attempts: number }, Ev, EvalPayload>;
 * }, AgentDeps>({
 *     context: { inherit: ["messages"] as const, local: { attempts: 0 } },
 *     initial: "thinking",
 *     modes: { thinking, evaluating },
 *     onDone: "listening",
 * });
 * ```
 */
export function defineMode<
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
    TDeps extends Record<string, unknown> = Record<string, never>,
>(
    config: ModeConfig<TParentContext, TEvents, TCtx, TModes, TDeps>,
): Mode<TParentContext, TEvents, TDeps> {
    const carrier: ModeCarrier<TParentContext, TEvents, TDeps> = {
        __kind: "compound",
        config,
    };
    return carrier as unknown as Mode<TParentContext, TEvents, TDeps>;
}
