// `defineMode` — constructs a unified leaf agent Mode.
//
// Spec: docs/specs/011-self-suspending-modes.md §The model / §Surface
//        (supersedes the active/passive split from spec 004 §`defineMode`).
//        + docs/specs/005-agent-deps-and-stringifiable-context.md §`defineMode`
//
// SPEC 011: there is no longer an active vs passive *type* split. Every mode has
// a `behavior`; `start` is a single activation bit. `defineMode` is overloaded
// so the behavior's `event` narrows by start — `start: "event"` sees `TEvents`,
// `start: "run"` sees `TEvents | undefined`. Phase 3 stays a thin shell: store
// the config plus the `__kind: "leaf"` tag behind the opaque `Mode` brand;
// `compile.ts` lowers.

import type {
    EventModeConfig,
    Mode,
    ModeConfig,
    RunModeConfig,
} from "./types.ts";

/**
 * Runtime carrier behind the opaque `Mode` brand. Internal — accessed only by
 * `compile.ts` via the `__kind` discriminant. The unified `ModeConfig` keeps
 * `start` so the lowering can tell a run-mode from an event-mode.
 */
export type ModeCarrier<
    TContext,
    TEvents extends { type: string },
    TPayload,
    TDeps extends Record<string, unknown> = Record<string, never>,
> = {
    readonly __kind: "leaf";
    readonly config: ModeConfig<TContext, TEvents, TPayload, TDeps>;
};

/**
 * Construct a **leaf Mode** (SPEC 011 — one unified primitive).
 *
 * A mode always has a `behavior`. Two things shape it:
 *
 * - **`start`** — *how the mode is activated*. `"run"` (default) enters by
 *   running the behavior immediately (no event yet, `event: undefined`).
 *   `"event"` enters parked; the behavior runs only when a declared event
 *   arrives (`event: TEvents`).
 * - **the behavior's return** — `{ outcome: "achieved" | "abandoned" }` to
 *   LEAVE (dispatched by `routes`, each carries a `target`), or
 *   `{ stay: "replay" | "waitOnEvent" }` to STAY and re-run (dispatched by
 *   `stay`, no target). `replay` re-runs now; `waitOnEvent` re-runs on the
 *   next declared event.
 *
 * @example Run mode (default) — collapse a teach/listen/evaluate loop into one.
 * ```ts
 * const socratic = defineMode<Ctx, Ev, Pay, Deps>({
 *     input: ({ context }) => ({ messages: context.messages }),
 *     events: ["MESSAGE"],
 *     behavior: async ({ input, event, deps }) => {
 *         if (event?.type === "MESSAGE") { ... return { outcome: "achieved", payload }; }
 *         await deps.teach(...);
 *         return { stay: "waitOnEvent", payload };
 *     },
 *     routes: { achieved: { target: END }, abandoned: { target: END } },
 *     stay: { waitOnEvent: {} },
 * });
 * ```
 *
 * @example Event mode — park until a MESSAGE, then process it (no guard).
 * ```ts
 * const idle = defineMode<Ctx, Ev, Pay, Deps>({
 *     start: "event",
 *     events: ["MESSAGE"],
 *     input: ({ context }) => ({ messages: context.messages }),
 *     behavior: async ({ event }) => ({ outcome: "achieved", payload: { text: event.text } }),
 *     routes: { achieved: { target: "next" }, abandoned: { target: END } },
 * });
 * ```
 */
// Event overload first: its required `start: "event"` is the more specific
// match, so a `{ start: "event", ... }` config resolves here (event: TEvents).
export function defineMode<
    TContext,
    TEvents extends { type: string },
    TPayload = unknown,
    TDeps extends Record<string, unknown> = Record<string, never>,
>(
    config: EventModeConfig<TContext, TEvents, TPayload, TDeps>,
): Mode<TContext, TEvents, TPayload, TDeps>;
// Run overload (default): `start` omitted or "run" (event: TEvents | undefined).
export function defineMode<
    TContext,
    TEvents extends { type: string },
    TPayload = unknown,
    TDeps extends Record<string, unknown> = Record<string, never>,
>(
    config: RunModeConfig<TContext, TEvents, TPayload, TDeps>,
): Mode<TContext, TEvents, TPayload, TDeps>;
export function defineMode<
    TContext,
    TEvents extends { type: string },
    TPayload = unknown,
    TDeps extends Record<string, unknown> = Record<string, never>,
>(
    config: ModeConfig<TContext, TEvents, TPayload, TDeps>,
): Mode<TContext, TEvents, TPayload, TDeps> {
    const carrier: ModeCarrier<TContext, TEvents, TPayload, TDeps> = {
        __kind: "leaf",
        config,
    };
    // The brand is a phantom — at runtime the object is just the carrier. This
    // cast is the single boundary where the opaque type is minted.
    return carrier as unknown as Mode<TContext, TEvents, TPayload, TDeps>;
}
