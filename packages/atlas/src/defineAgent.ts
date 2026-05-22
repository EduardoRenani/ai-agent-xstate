// `defineAgent` — constructs the root XState machine.
//
// Spec: docs/specs/004-xstate-agent-wrapper.md §`defineAgent`.
//
// `defineAgent` is the only constructor that touches `xstate`: it returns an
// `AnyStateMachine` so the rest of the project (`createActor`, the inspector,
// existing tests) keeps working unchanged. The lowering itself lives in
// `compile.ts`.

import type { AnyStateMachine } from "xstate";

import { compile } from "./compile.ts";
import type { AgentConfig, ModesMap } from "./types.ts";

/**
 * Construct the **root agent** — compiles the declarative `AgentConfig` into
 * a runnable XState machine. This is the single boundary where the wrapper
 * touches `xstate`: the return type is `AnyStateMachine`, so callers feed it
 * straight into `createActor`, the inspector, and existing tests.
 *
 * The agent's `modes` map can mix `LeafMode`s and nested `Mode`s freely. The
 * compile step lowers them, validates sibling-target references, injects the
 * `END` synthetic state per-compound when referenced, and wires the
 * payload-driven `routes` into XState transitions.
 *
 * @template TContext  The agent's root context shape. Every leaf and compound
 *                     in the tree sees this (or a narrowed view of it).
 * @template TEvents   The agent's full event union. Each variant must have a
 *                     `type: string` discriminant. Pass `{} as Ev` to the
 *                     `events` field — only its type matters; it's a phantom.
 * @template TModes    The root `modes` map. `initial` is keyed against this
 *                     type so a typo is a compile error.
 *
 * @param config  `{ id, initial, context, events, actions?, modes }`.
 *                `actions` registers reusable, pure callbacks (each returning
 *                `Partial<TContext>`) referenced by name from passive
 *                `on[event].actions`. The wrapper wraps them in `assign(...)`
 *                at compile time, so user code never imports from `xstate`.
 *
 * @returns An `AnyStateMachine` ready to pass to `createActor`.
 *
 * @example
 * ```ts
 * const agent = defineAgent<Ctx, Ev, Modes>({
 *     id: "zoe",
 *     initial: "listening",
 *     context: { messages: [], attempts: 0 },
 *     events: {} as Ev,
 *     actions: {
 *         appendUserMsg: ({ context, event }) =>
 *             event.type === "USER_MSG"
 *                 ? { messages: [...context.messages, { role: "user", content: event.text }] }
 *                 : {},
 *     },
 *     modes: { listening, classifying, greetings, socratic },
 * });
 *
 * const actor = createActor(agent).start();
 * actor.send({ type: "USER_MSG", text: "hi" });
 * ```
 */
export function defineAgent<
    TContext,
    TEvents extends { type: string },
    TModes extends ModesMap<TContext, TEvents>,
>(config: AgentConfig<TContext, TEvents, TModes>): AnyStateMachine {
    return compile(config);
}
