// `defineAgent` — constructs the root agent handle.
//
// Spec: docs/specs/004-xstate-agent-wrapper.md §`defineAgent`
//        + docs/specs/005-agent-deps-and-stringifiable-context.md §`defineAgent`
//        + docs/specs/012-xstate-containment.md §Seam 1 (DD-030)
//
// SPEC 012 §Seam 1: `defineAgent` returns an opaque `Agent<TContext, TEvents>`
// handle, not the carrier machine. The compiled carrier is wrapped behind the
// Atlas brand so no engine type reaches a consumer-facing signature; only
// `startAgent` unwraps it. The lowering itself lives in `compile.ts`.
//
// Deps lifecycle (spec 005 §Imutabilidade):
//   - `Object.freeze` is applied once, here, before the closure is captured.
//   - The frozen reference is threaded to `compile.ts`, which captures it in
//     every generated callback's closure. There is no runtime path to swap
//     deps after this call returns.

import { compile } from "./compile.ts";
import type { Agent, AgentConfig, ModesMap } from "./types.ts";

/**
 * Construct the **root agent** — compiles the declarative `AgentConfig` into a
 * runnable `Agent<TContext, TEvents>` handle. Boot it with `startAgent`; the
 * handle is opaque and Atlas-owned (spec 012 §Seam 1).
 *
 * The agent's `modes` map can mix `Mode`s (leaves) and nested `CompoundMode`s
 * freely. The compile step lowers them, validates sibling-target references,
 * injects the `END` synthetic state per-compound when referenced, and wires
 * the payload-driven `routes` into transitions.
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
 *                passive `on[event].actions`. Atlas applies the context-merge
 *                at compile time, so user code never imports from the engine.
 *
 * @returns An opaque `Agent<TContext, TEvents>` handle. Boot it with
 *          `startAgent(agent)`, which infers `TContext`/`TEvents` from the
 *          brand — there is no other entry point.
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
 * const actor = startAgent(agent); // Ctx/Ev inferred from the handle
 * actor.send({ type: "USER_MSG", text: "hi" });
 * ```
 */
export function defineAgent<
    TContext,
    TEvents extends { type: string },
    TModes extends ModesMap<TContext, TEvents, TDeps>,
    TDeps extends Record<string, unknown> = Record<string, never>,
>(config: AgentConfig<TContext, TEvents, TModes, TDeps>): Agent<TContext, TEvents> {
    // Spec 005 §Imutabilidade: shallow freeze the deps container once, here,
    // before passing the reference to `compile`. The default-empty branch
    // produces a frozen `{}` so callbacks observe `Object.isFrozen(deps) === true`
    // even when the consumer omits `deps`.
    const frozenDeps = Object.freeze(config.deps ?? ({} as TDeps));
    // SPEC 012 §Seam 1: wrap the compiled carrier in the opaque Agent brand.
    // The brand's properties are phantom at the type level (`agentBrand`,
    // `__phantomAgent`); only `carrier` is a real runtime field. The single
    // cast here is the seam's one localized type assertion on the produce side.
    return { carrier: compile(config, frozenDeps) } as Agent<TContext, TEvents>;
}
