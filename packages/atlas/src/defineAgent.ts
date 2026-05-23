// `defineAgent` — constructs the root XState machine.
//
// Spec: docs/specs/004-xstate-agent-wrapper.md §`defineAgent`
//        + docs/specs/005-agent-deps-and-stringifiable-context.md §`defineAgent`
//
// `defineAgent` is the only constructor that touches `xstate`: it returns an
// `AnyStateMachine` so the rest of the project (`createActor`, the inspector,
// existing tests) keeps working unchanged. The lowering itself lives in
// `compile.ts`.
//
// Deps lifecycle (spec 005 §Imutabilidade):
//   - `Object.freeze` is applied once, here, before the closure is captured.
//   - The frozen reference is threaded to `compile.ts`, which captures it in
//     every generated callback's closure. There is no runtime path to swap
//     deps after this call returns.

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
 * @template TContext  The agent's root context shape. Constrained to
 *                     `JsonCompatible<TContext>` so the snapshot round-trips
 *                     through arbitrary storage without custom encoding.
 * @template TEvents   The agent's full event union. Each variant must have a
 *                     `type: string` discriminant. Pass `{} as Ev` to the
 *                     `events` field — only its type matters; it's a phantom.
 * @template TModes    The root `modes` map. `initial` is keyed against this
 *                     type so a typo is a compile error.
 * @template TDeps     Frozen container of external resources. Defaults to
 *                     `Record<string, never>` when `deps` is omitted —
 *                     callbacks still receive `deps`, typed as the empty
 *                     object, so the envelope shape stays uniform.
 *
 * @param config  `{ id, initial, context, events, deps?, actions?, modes }`.
 *                `actions` registers reusable, deps-aware callbacks (each
 *                returning `Partial<TContext>`) referenced by name from
 *                passive `on[event].actions`. The wrapper wraps them in
 *                `assign(...)` at compile time, so user code never imports
 *                from `xstate`.
 *
 * @returns An `AnyStateMachine` ready to pass to `createActor`.
 *
 * @example
 * ```ts
 * const agent = defineAgent<Ctx, Ev, Modes, { db: Driver; logger: Logger }>({
 *     id: "zoe",
 *     initial: "listening",
 *     context: { messages: [], attempts: 0 },
 *     events: {} as Ev,
 *     deps: { db: realDb, logger: pino() },
 *     actions: {
 *         appendUserMsg: ({ context, event, deps }) =>
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
    TModes extends ModesMap<TContext, TEvents, TDeps>,
    TDeps extends Record<string, unknown> = Record<string, never>,
>(config: AgentConfig<TContext, TEvents, TModes, TDeps>): AnyStateMachine {
    // Spec 005 §Imutabilidade: shallow freeze the deps container once, here,
    // before passing the reference to `compile`. The default-empty branch
    // produces a frozen `{}` so callbacks observe `Object.isFrozen(deps) === true`
    // even when the consumer omits `deps`.
    const frozenDeps = Object.freeze(config.deps ?? ({} as TDeps));
    return compile(config, frozenDeps);
}
