// `defineMode` — constructs a compound mode (a state with substates).
//
// Spec: docs/specs/004-xstate-agent-wrapper.md §`defineMode` + §Type contract.
//
// Like `defineLeafMode`, this is a thin Phase 3 shell. The generics enforce
// the compound-local context narrowing at the call site: children's
// `TContext` is `LocalContextOf<TParentContext, TCtx>`. The compile step in
// `compile.ts` lowers the carrier to XState states later.

import type {
    CompoundContext,
    LocalContextOf,
    Mode,
    ModeConfig,
    StatesMap,
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
 */
export type ModeCarrier<TParentContext, TEvents extends { type: string }> = {
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
 *                           compound. At the agent root, this is the agent's
 *                           full context.
 * @template TEvents         The agent's full event union (each variant has a
 *                           `type` discriminant).
 * @template TCtx            Either `undefined` (no narrowing — children see
 *                           `TParentContext`) or a `CompoundContext` literal
 *                           declaring which keys to `inherit` and which `local`
 *                           variables to declare.
 * @template TStates         The compound's `states` map. Each slot is a
 *                           `LeafMode` or nested `Mode` typed against the
 *                           compound-local context view.
 *
 * @param config  `{ context?, initial, states, onDone }`. `initial` is keyed
 *                against `TStates` so a typo is a compile error. `onDone`
 *                accepts a sibling name or `END` (when nested further).
 *
 * @returns An opaque `Mode` brand. Only `defineMode` / `defineAgent` accept it
 *          as a `states` slot.
 *
 * @example Compound with context narrowing — children see only `messages`.
 * ```ts
 * const socratic = defineMode<AgentCtx, Ev, {
 *     inherit: ["messages"];
 *     local: { attempts: number };
 * }, {
 *     thinking: LeafMode<{ messages: Msg[]; attempts: number }, Ev>;
 *     evaluating: LeafMode<{ messages: Msg[]; attempts: number }, Ev, EvalPayload>;
 * }>({
 *     context: { inherit: ["messages"] as const, local: { attempts: 0 } },
 *     initial: "thinking",
 *     states: { thinking, evaluating },
 *     onDone: "listening",
 * });
 * ```
 */
export function defineMode<
    TParentContext,
    TEvents extends { type: string },
    TCtx extends
        | CompoundContext<TParentContext, ReadonlyArray<keyof TParentContext & string>, object>
        | undefined,
    TStates extends StatesMap<LocalContextOf<TParentContext, TCtx>, TEvents>,
>(
    config: ModeConfig<TParentContext, TEvents, TCtx, TStates>,
): Mode<TParentContext, TEvents> {
    const carrier: ModeCarrier<TParentContext, TEvents> = {
        __kind: "compound",
        config,
    };
    return carrier as unknown as Mode<TParentContext, TEvents>;
}
