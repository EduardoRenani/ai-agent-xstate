// `defineLeafMode` — constructs a leaf agent mode (active or passive variant).
//
// Spec: docs/specs/004-xstate-agent-wrapper.md §`defineLeafMode` + §Type contract.
//
// Phase 3 (these constructors) is a thin shell: it stores the user's config
// plus a runtime `__kind` tag behind the opaque `LeafMode` brand. The actual
// XState lowering happens in `compile.ts` (Phase 5) and is reached only via
// `defineAgent`. Users never inspect the returned object.

import type { LeafMode, LeafModeConfig } from "./types.ts";

/**
 * Runtime carrier behind the opaque `LeafMode` brand. Internal — accessed
 * only by `compile.ts` via the `__kind` discriminant. User code never sees
 * this shape because `defineLeafMode` returns the branded type.
 *
 * @template TContext  Context shape this leaf reads/writes.
 * @template TEvents   The agent's full event union (each variant has a `type`).
 * @template TPayload  Payload shape carried by `ModeOutput<TPayload>`.
 */
export type LeafModeCarrier<TContext, TEvents extends { type: string }, TPayload> = {
    readonly __kind: "leaf";
    readonly config: LeafModeConfig<TContext, TEvents, TPayload>;
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
 * @template TContext  Shape of the context this leaf observes. At the agent's
 *                     top level, this is the agent's full context. Inside a
 *                     `defineMode` with a narrowing `context`, this is the
 *                     compound-local view: inherited keys + declared locals.
 * @template TEvents   The agent's full event union. Each variant must have a
 *                     `type: string` discriminant. Passive `on` handlers are
 *                     typed against this union via `Extract<TEvents, { type: K }>`.
 * @template TPayload  Payload type carried on a successful `behavior` return
 *                     (`ModeOutput<TPayload>`). Flows into `routes.*.when` and
 *                     `routes.*.assign` for payload-driven dispatch. Defaults
 *                     to `unknown` (relevant only for passive leaves, which
 *                     never produce a payload).
 *
 * @param config  An `ActiveLeafModeConfig` or a `PassiveLeafModeConfig`. The
 *                discriminator is structural — TypeScript picks the variant
 *                from which keys are present.
 *
 * @returns An opaque `LeafMode` brand. User code cannot inspect it; only
 *          `defineMode` and `defineAgent` accept it as a `states` slot.
 *
 * @example Active leaf — classify an intent and route on the payload.
 * ```ts
 * const classifying = defineLeafMode<Ctx, Ev, { intent: "greet" | "learn" }>({
 *     input: ({ context }) => ({ messages: context.messages }),
 *     behavior: async ({ input }) => {
 *         const intent = await classify(input);
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
>(
    config: LeafModeConfig<TContext, TEvents, TPayload>,
): LeafMode<TContext, TEvents, TPayload> {
    const carrier: LeafModeCarrier<TContext, TEvents, TPayload> = {
        __kind: "leaf",
        config,
    };
    // The brand is a phantom — at runtime the object is just the carrier.
    // The cast is the single boundary where the opaque type is minted; user
    // code can only obtain `LeafMode` values through this function.
    return carrier as unknown as LeafMode<TContext, TEvents, TPayload>;
}
