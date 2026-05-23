// `defineLeafMode` — constructs a leaf agent mode (active or passive variant).
//
// Spec: docs/specs/004-xstate-agent-wrapper.md §`defineLeafMode`
//        + docs/specs/005-agent-deps-and-stringifiable-context.md §`defineLeafMode`.
//
// Phase 3 (these constructors) is a thin shell: it stores the user's config
// plus a runtime `__kind` tag behind the opaque `LeafMode` brand. The actual
// XState lowering happens in `compile.ts` (Phase 5) and is reached only via
// `defineAgent`. Users never inspect the returned object.
//
// The `TDeps` generic flows through to the brand via `__phantomDeps`, which
// puts it in function-argument position — making `LeafMode` contravariant in
// `TDeps`. That gives the slot-time variance check in `defineAgent.modes`
// the right direction structurally: a `LeafMode` demanding `{ db }` slots
// into agents whose deps include at least `db`.

import type { LeafMode, LeafModeConfig } from "./types.ts";

/**
 * Runtime carrier behind the opaque `LeafMode` brand. Internal — accessed
 * only by `compile.ts` via the `__kind` discriminant. User code never sees
 * this shape because `defineLeafMode` returns the branded type.
 *
 * @template TContext  Context shape this leaf reads/writes.
 * @template TEvents   The agent's full event union (each variant has a `type`).
 * @template TPayload  Payload shape carried by `ModeOutput<TPayload>`.
 * @template TDeps     Frozen deps container this leaf demands.
 */
export type LeafModeCarrier<
    TContext,
    TEvents extends { type: string },
    TPayload,
    TDeps extends Record<string, unknown> = Record<string, never>,
> = {
    readonly __kind: "leaf";
    readonly config: LeafModeConfig<TContext, TEvents, TPayload, TDeps>;
};

/**
 * Construct a **leaf mode** — one node in the agent's state tree with no
 * sub-states. Leaf modes come in two structural flavors:
 *
 * - **Active** (`{ input, behavior, routes }`) — runs an async `behavior` and
 *   dispatches on its `ModeOutput`. Use for LLM calls, tool execution,
 *   classifiers — anything that does work and then decides where to go next.
 *
 * - **Passive** (`{ on }`) — waits for an external event. Use for listening
 *   states or user-input gates.
 *
 * The two variants are mutually exclusive at the type level: mixing `behavior`
 * and `on` is a compile error.
 *
 * @template TContext  Shape of the context this leaf observes. Constrained to
 *                     `JsonCompatible<TContext>`. At the agent's top level,
 *                     this is the agent's full context. Inside a `defineMode`
 *                     with a narrowing `context`, this is the compound-local
 *                     view: inherited keys + declared locals.
 * @template TEvents   The agent's full event union. Each variant must have a
 *                     `type: string` discriminant. Passive `on` handlers are
 *                     typed against this union via `Extract<TEvents, { type: K }>`.
 * @template TPayload  Payload type carried on a successful `behavior` return
 *                     (`ModeOutput<TPayload>`). Flows into `routes.*.when` and
 *                     `routes.*.assign` for payload-driven dispatch. Defaults
 *                     to `unknown` (relevant only for passive leaves, which
 *                     never produce a payload).
 * @template TDeps     Frozen deps this leaf wants to see. Defaults to
 *                     `Record<string, never>` — a leaf with the default
 *                     slots into any agent. A leaf that declares
 *                     `<…, { db: Driver }>` can only slot into agents whose
 *                     `defineAgent.deps` provides at least `db`.
 *
 * @param config  An `ActiveLeafModeConfig` or a `PassiveLeafModeConfig`. The
 *                discriminator is structural — TypeScript picks the variant
 *                from which keys are present.
 *
 * @returns An opaque `LeafMode` brand. User code cannot inspect it; only
 *          `defineMode` and `defineAgent` accept it as a `modes` slot.
 *
 * @example Active leaf — classify an intent and route on the payload.
 * ```ts
 * const classifying = defineLeafMode<Ctx, Ev, { intent: "greet" | "learn" }>({
 *     input: ({ context, deps }) => ({ messages: context.messages }),
 *     behavior: async ({ input, deps }) => {
 *         const intent = await deps.llm.classify(input);
 *         return { outcome: "achieved", payload: { intent } };
 *     },
 *     routes: {
 *         achieved: [
 *             { when: (p) => p.intent === "greet", target: "greetings" },
 *             { target: "socratic" },
 *         ],
 *         retry: [],
 *         abandoned: { target: END },
 *     },
 * });
 * ```
 *
 * @example Passive leaf — park here until a `USER_MSG` event arrives.
 * ```ts
 * const listening = defineLeafMode<Ctx, Ev>({
 *     on: {
 *         USER_MSG: { target: "classifying", actions: "appendUserMsg" },
 *     },
 * });
 * ```
 */
export function defineLeafMode<
    TContext,
    TEvents extends { type: string },
    TPayload = unknown,
    TDeps extends Record<string, unknown> = Record<string, never>,
>(
    config: LeafModeConfig<TContext, TEvents, TPayload, TDeps>,
): LeafMode<TContext, TEvents, TPayload, TDeps> {
    const carrier: LeafModeCarrier<TContext, TEvents, TPayload, TDeps> = {
        __kind: "leaf",
        config,
    };
    // The brand is a phantom — at runtime the object is just the carrier.
    // The cast is the single boundary where the opaque type is minted; user
    // code can only obtain `LeafMode` values through this function.
    return carrier as unknown as LeafMode<TContext, TEvents, TPayload, TDeps>;
}
