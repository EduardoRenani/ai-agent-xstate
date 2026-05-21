// Atlas — type contract for the XState agent wrapper.
//
// Spec: docs/specs/004-xstate-agent-wrapper.md §"Type contract"
//
// This file is pure types + symbol declarations. Runtime construction lives in
// defineLeafMode.ts / defineMode.ts / defineAgent.ts / compile.ts.

// ── Outcomes & ModeOutput ────────────────────────────────────────────

/**
 * The three intentional outcomes a leaf's `behavior` can return:
 *
 * - **`"achieved"`** — the leaf's work succeeded. Dispatch via `routes.achieved`.
 * - **`"retry"`** — the leaf should run again on the same state (self-loop).
 *   Dispatch via `routes.retry`.
 * - **`"abandoned"`** — the leaf's work failed in an *expected* way (give up,
 *   not crash). Dispatch via `routes.abandoned`.
 *
 * A fourth outcome (`error`) exists, but it is **synthesized by the wrapper**
 * when `behavior` rejects — users never return it, and it is intentionally
 * absent from this union.
 */
export type Outcome = "achieved" | "retry" | "abandoned";

/**
 * The return type of an active leaf's `behavior`. The wrapper inspects
 * `outcome` to pick the right route bucket and threads `payload` into the
 * matched route's `when` / `assign` callbacks.
 *
 * @template TPayload  Shape of the payload. Constrains the inputs of all
 *                     `routes.*.when` and `routes.*.assign` callbacks on the
 *                     same leaf, so payload-driven dispatch stays type-safe.
 */
export type ModeOutput<TPayload = unknown> = {
    outcome: Outcome;
    payload: TPayload;
};

// ── Exit & re-throw tokens ───────────────────────────────────────────

/**
 * `END` — the only way for a route to leave a compound mode. Implemented as a
 * unique symbol so it cannot collide with state names (DD-015).
 *
 * Use as a `target` on `achieved` / `abandoned` route entries when you want
 * the enclosing compound's `onDone` transition to fire.
 *
 * @example
 * ```ts
 * routes: {
 *     achieved: { target: END },     // leave the compound on success
 *     retry: [],
 *     abandoned: { target: END },    // leave the compound on giving up
 * }
 * ```
 */
export const END: unique symbol = Symbol("atlas.END");
export type END = typeof END;

/**
 * `RE_THROW` — an error-only `target` that re-propagates the caught rejection
 * above the actor instead of transitioning. Lets `routes.error` filter out
 * programmer errors (TypeError, etc.) without putting `throw` inside `assign`.
 *
 * Valid **only** on `ErrorEntry.target`. Using it on `achieved` / `abandoned`
 * entries is a compile error.
 *
 * @example
 * ```ts
 * routes: {
 *     error: [
 *         { when: (e) => e instanceof TypeError, target: RE_THROW },
 *         { target: "fallback" },
 *     ],
 * }
 * ```
 */
export const RE_THROW: unique symbol = Symbol("atlas.RE_THROW");
export type RE_THROW = typeof RE_THROW;

// ── Targets ──────────────────────────────────────────────────────────

/**
 * Target type for `achieved` / `abandoned` entries — a sibling state name or
 * `END`. The `string` half names a sibling in the **immediate enclosing**
 * `states` map; dotted paths, XState absolute paths (`#agent.foo`), and
 * descendant paths are NOT accepted (DD-016 / spec §"Target resolution").
 *
 * The type stays plain `string` because a leaf doesn't know its enclosing
 * siblings at definition time — the wrapper's compile step validates against
 * the actual sibling set and throws on machine creation.
 */
export type RouteTarget = string | END;

/**
 * Target type for `error` entries — additionally accepts `RE_THROW`, which
 * re-propagates the caught rejection above the actor instead of transitioning.
 */
export type ErrorRouteTarget = string | END | RE_THROW;

// ── Route entries ────────────────────────────────────────────────────

/**
 * A single entry in `routes.achieved` or `routes.abandoned`. Carries a
 * required `target` and optional `when` / `assign`.
 *
 * - `when(payload)` — guard. If present and returns false, the wrapper moves
 *   to the next entry. **Required on non-last entries** in the array form;
 *   omitting it is a compile error.
 * - `target` — the destination state (sibling name or `END`).
 * - `assign({ context, payload })` — return a `Partial<TContext>` to merge
 *   into context before the transition fires.
 *
 * @template TContext  Context shape visible to `assign`.
 * @template TPayload  Payload shape from `ModeOutput<TPayload>`.
 */
export type ExitEntry<TContext, TPayload> = {
    when?: (payload: TPayload) => boolean;
    target: RouteTarget;
    assign?: (args: { context: TContext; payload: TPayload }) => Partial<TContext>;
};

/**
 * A single entry in `routes.retry`. **Has no `target`** — retry is always a
 * structural self-loop on the same leaf (DD-014). Supplying `target` here is
 * a compile error.
 *
 * - `when(payload)` — guard. Required on non-last entries in array form.
 * - `assign({ context, payload })` — return a `Partial<TContext>` to merge
 *   into context before the self-transition fires.
 *
 * @template TContext  Context shape visible to `assign`.
 * @template TPayload  Payload shape from `ModeOutput<TPayload>`.
 */
export type RetryEntry<TContext, TPayload> = {
    when?: (payload: TPayload) => boolean;
    assign?: (args: { context: TContext; payload: TPayload }) => Partial<TContext>;
};

/**
 * A single entry in `routes.error`. Fired when `behavior` throws or its
 * Promise rejects. The wrapper catches the rejection, synthesizes the
 * outcome, and routes through these entries. `when` and `assign` receive the
 * **raw error**, not a payload.
 *
 * Setting `target: RE_THROW` re-propagates the caught error above the actor;
 * `assign` is ignored on RE_THROW entries (re-throwing is the side effect).
 *
 * @template TContext  Context shape visible to `assign`.
 */
export type ErrorEntry<TContext> = {
    when?: (error: unknown) => boolean;
    target: ErrorRouteTarget;
    assign?: (args: { context: TContext; error: unknown }) => Partial<TContext>;
};

// ── RouteList<E> — "first match wins, last entry is the default" ─────

/**
 * Helper: take an entry type `E` and **require** its `when` field.
 * Used by `RouteList` to enforce that every non-last entry carries a guard.
 *
 * @template E  An entry type (`ExitEntry` / `RetryEntry` / `ErrorEntry`) whose
 *              `when` is optional.
 */
export type WithWhen<E> = E extends { when?: infer W }
    ? Omit<E, "when"> & { when: NonNullable<W> }
    : E;

/**
 * Helper: take an entry type `E` and **strip** its `when` field. Used by
 * `RouteList` for the trailing default entry — its `when` must not be
 * present, even as `undefined`.
 *
 * @template E  An entry type whose `when` should be removed.
 */
export type NoWhen<E> = Omit<E, "when">;

/**
 * Encodes the array-form rule "**first match wins, last entry is the
 * default**" at the type level. Non-last entries are required to carry
 * `when`; the last entry must omit it. This makes the misplacement of
 * `when` (an unguarded entry shadowing later entries — dead code at runtime)
 * a compile error rather than a silent routing bug.
 *
 * Two valid shapes:
 * - Single-entry: just the default — `readonly [NoWhen<E>]`.
 * - Multi-entry: one or more guarded entries followed by the default.
 *
 * `readonly []` is unrepresentable here — the type system rejects it for
 * `achieved` / `abandoned` / `error`. `retry` permits `readonly []`
 * separately as the "no special handling" shorthand.
 *
 * @template E  The entry type (`ExitEntry` / `RetryEntry` / `ErrorEntry`).
 */
export type RouteList<E> =
    | readonly [NoWhen<E>]
    | readonly [WithWhen<E>, ...readonly WithWhen<E>[], NoWhen<E>];

// ── Routes — the four-key map ────────────────────────────────────────

/**
 * The full route table for an active leaf — one bucket per `Outcome`, plus an
 * optional `error` bucket for synthesized errors.
 *
 * - **`achieved`** (required) — fired when `behavior` returns `outcome: "achieved"`.
 * - **`retry`** (required) — fired when `behavior` returns `outcome: "retry"`.
 *   Pass `readonly []` for "no special handling" (the wrapper just re-enters
 *   the same leaf).
 * - **`abandoned`** (required) — fired when `behavior` returns `outcome: "abandoned"`.
 * - **`error`** (optional) — fired when `behavior` throws / its Promise
 *   rejects. **When omitted, the wrapper re-throws the rejection above the
 *   actor.** This is the only safe default — silently swallowing failures is
 *   not allowed.
 *
 * Each bucket accepts either a single entry or a `RouteList` (first-match-wins
 * array). See `RouteList` for the array-form rules.
 *
 * @template TContext  Context shape visible to `when` / `assign` callbacks.
 * @template TPayload  Payload type returned by `behavior`.
 */
export type Routes<TContext, TPayload> = {
    achieved: ExitEntry<TContext, TPayload> | RouteList<ExitEntry<TContext, TPayload>>;
    retry:
        | RetryEntry<TContext, TPayload>
        | readonly []
        | RouteList<RetryEntry<TContext, TPayload>>;
    abandoned: ExitEntry<TContext, TPayload> | RouteList<ExitEntry<TContext, TPayload>>;
    error?: ErrorEntry<TContext> | RouteList<ErrorEntry<TContext>>;
};

// ── Event handlers (passive mode) ────────────────────────────────────

/**
 * A single passive transition. Fired when the matching event arrives while
 * the leaf is active. For array-form handlers, first match wins (XState
 * semantics).
 *
 * - `target` — sibling name or `END`. Passive modes CAN leave a compound on
 *   a particular event.
 * - `actions` — a name (or list of names) referencing entries declared in
 *   `defineAgent.actions`. **Inline callbacks are NOT accepted here** —
 *   that would re-introduce DD-004 churn.
 * - `guard({ context, event })` — optional. The transition only fires when
 *   it returns true.
 *
 * @template TContext       Context shape visible to `guard`.
 * @template TEventVariant  The specific event variant this transition handles
 *                          (narrowed from `TEvents` by the discriminant key).
 */
export type EventTransition<TContext, TEventVariant> = {
    target?: RouteTarget;
    actions?: string | readonly string[];
    guard?: (args: { context: TContext; event: TEventVariant }) => boolean;
};

/**
 * The full `on` map for a passive leaf. Keys are event discriminants
 * (`event.type`); values are one transition or an ordered list of them. The
 * transition's `event` callback argument is automatically narrowed to the
 * matching event variant via `Extract<TEvents, { type: K }>`.
 *
 * @template TContext  Context shape visible to `guard`.
 * @template TEvents   The agent's full event union (each variant has a `type`).
 */
export type EventHandlers<TContext, TEvents extends { type: string }> = {
    [K in TEvents["type"]]?:
        | EventTransition<TContext, Extract<TEvents, { type: K }>>
        | readonly EventTransition<TContext, Extract<TEvents, { type: K }>>[];
};

// ── LeafMode config (discriminated union) ────────────────────────────

/**
 * Active leaf shape — runs an async `behavior` and dispatches on its
 * `ModeOutput`. Mutually exclusive with `PassiveLeafModeConfig`; mixing
 * `behavior` and `on` in the same config is a compile error (DD-019).
 *
 * @template TContext  Context shape visible to `input` / `routes.*.assign`.
 * @template TEvents   Phantom — kept for symmetry with the passive variant.
 *                     Active leaves don't observe events directly.
 * @template TPayload  Payload type returned by `behavior` and threaded into
 *                     `routes.*.when` / `routes.*.assign`.
 */
export type ActiveLeafModeConfig<TContext, TEvents extends { type: string }, TPayload> = {
    input: (args: { context: TContext }) => unknown;
    behavior: (args: { input: unknown }) => Promise<ModeOutput<TPayload>>;
    routes: Routes<TContext, TPayload>;
};

/**
 * Passive leaf shape — waits for external events. Mutually exclusive with
 * `ActiveLeafModeConfig`.
 *
 * @template TContext  Context shape visible to `on[event].guard`.
 * @template TEvents   The agent's full event union.
 */
export type PassiveLeafModeConfig<TContext, TEvents extends { type: string }> = {
    on: EventHandlers<TContext, TEvents>;
};

/**
 * The discriminated union of leaf config shapes. TypeScript picks the variant
 * structurally — by which keys you supply.
 *
 * @template TContext  Context shape this leaf observes.
 * @template TEvents   The agent's full event union.
 * @template TPayload  Payload type for the active variant. Ignored by passive.
 */
export type LeafModeConfig<TContext, TEvents extends { type: string }, TPayload> =
    | ActiveLeafModeConfig<TContext, TEvents, TPayload>
    | PassiveLeafModeConfig<TContext, TEvents>;

// ── Opaque mode markers ──────────────────────────────────────────────

// `LeafMode` and `Mode` are opaque to user code — only `defineLeafMode` and
// `defineMode` can produce values of these types. Internal shape (config,
// kind tag) is implementation detail of the wrapper; Phase 3's constructors
// attach the runtime payload behind the brand.
declare const __leafBrand: unique symbol;
declare const __modeBrand: unique symbol;

/**
 * Opaque brand returned by `defineLeafMode`. User code cannot inspect the
 * inside — the brand exists only so that `states` slots reject anything
 * other than the output of `defineLeafMode` / `defineMode`. The phantom
 * `__phantomLeaf` field preserves the generic parameters for inference at
 * slot sites.
 *
 * @template TContext  Context shape this leaf observes.
 * @template TEvents   The agent's full event union.
 * @template TPayload  Payload type returned by the active variant's `behavior`.
 */
export interface LeafMode<
    TContext,
    TEvents extends { type: string },
    TPayload = unknown,
> {
    readonly [__leafBrand]: true;
    readonly __phantomLeaf?: {
        context: TContext;
        events: TEvents;
        payload: TPayload;
    };
}

/**
 * Opaque brand returned by `defineMode`. As with `LeafMode`, user code cannot
 * inspect the inside; the brand only exists to constrain what `states` slots
 * accept.
 *
 * @template TContext  Context shape provided by the enclosing scope.
 * @template TEvents   The agent's full event union.
 */
export interface Mode<TContext, TEvents extends { type: string }> {
    readonly [__modeBrand]: true;
    readonly __phantomMode?: {
        context: TContext;
        events: TEvents;
    };
}

// ── States map (compound or agent level) ─────────────────────────────

/**
 * A `states` map — used at the agent root and inside every compound. Each
 * slot is a `LeafMode` or nested `Mode`. **Raw XState configs are not
 * accepted** — `defineLeafMode` / `defineMode` are the only way in.
 *
 * @template TContext  Context shape visible to every slot in this map.
 * @template TEvents   The agent's full event union.
 */
export type StatesMap<TContext, TEvents extends { type: string }> = Readonly<Record<
    string,
    LeafMode<TContext, TEvents> | Mode<TContext, TEvents>
>>;

// ── Compound-local context (lexical scoping) ─────────────────────────

/**
 * Compound-local context declaration. Used as the optional `context` field on
 * `ModeConfig` to narrow what children see.
 *
 * - **`inherit`** — list of keys from the enclosing context that are
 *   **live-mirrored** into this compound. Keys NOT in `inherit` are invisible
 *   to children at the type level.
 * - **`local`** — own variables declared at this compound. Initialized on
 *   entry and **reset on re-entry** (DD-018).
 *
 * Children see `Pick<TParent, inherit[number]> & typeof local` as their
 * context.
 *
 * @template TParent   The enclosing context shape.
 * @template TInherit  A `readonly` tuple of string keys of `TParent`. Must be
 *                     literal (e.g. `["messages"] as const`) so the element
 *                     type is preserved exactly.
 * @template TLocal    The shape of declared local variables (object literal).
 */
export type CompoundContext<
    TParent,
    TInherit extends ReadonlyArray<keyof TParent & string>,
    TLocal extends object,
> = {
    inherit: TInherit;
    local: TLocal;
};

/**
 * Compute the effective context a compound's children see, given the
 * enclosing `TParent` and the compound's `TCtx`. When `TCtx` is `undefined`
 * the children see the full enclosing context (no narrowing, no locals).
 *
 * @template TParent  The enclosing context shape.
 * @template TCtx     Either a `CompoundContext` literal or `undefined`.
 */
export type LocalContextOf<TParent, TCtx> =
    TCtx extends CompoundContext<TParent, infer I, infer L>
        ? Pick<TParent, I[number] & keyof TParent> & L
        : TParent;

// ── ModeConfig & AgentConfig ─────────────────────────────────────────

/**
 * The config passed to `defineMode`. `initial` is typed as `keyof TStates` so
 * a typo here is a compile error. `onDone` is the parent-level transition
 * target fired when any child routes to `END`; it accepts a sibling name OR
 * `END` (when the compound itself is nested inside another).
 *
 * `context` is OPTIONAL. When present, children see only
 * `Pick<TParentContext, inherit[number]> & typeof local`; when omitted they
 * see the full `TParentContext`. See `defineMode` §"Lexical scoping".
 *
 * @template TParentContext  Context shape the enclosing scope provides.
 * @template TEvents         The agent's full event union.
 * @template TCtx            Either a `CompoundContext` literal or `undefined`.
 * @template TStates         The compound's `states` map, typed against the
 *                           compound-local context view.
 */
export type ModeConfig<
    TParentContext,
    TEvents extends { type: string },
    TCtx extends
        | CompoundContext<TParentContext, ReadonlyArray<keyof TParentContext & string>, object>
        | undefined,
    TStates extends StatesMap<LocalContextOf<TParentContext, TCtx>, TEvents>,
> = {
    context?: TCtx;
    initial: keyof TStates & string;
    states: TStates;
    onDone: RouteTarget;
};

/**
 * The config passed to `defineAgent`. The root of the entire state tree.
 *
 * - **`id`** — XState machine id.
 * - **`initial`** — keyed against `TStates`; typo = compile error.
 * - **`context`** — the agent's root context literal.
 * - **`events`** — phantom field; only its type matters. Pass `{} as TEvents`.
 * - **`actions`** (optional) — registers reusable, pure callbacks referenced
 *   by name from passive `on[event].actions`. Each callback returns
 *   `Partial<TContext>`; the wrapper applies `assign(...)` at compile time so
 *   user code never imports from `xstate`. The callback's `event` is typed
 *   as the full `TEvents` union — narrowing is the action body's job.
 * - **`states`** — the root `states` map.
 *
 * @template TContext  The agent's root context shape.
 * @template TEvents   The agent's full event union.
 * @template TStates   The root `states` map.
 */
export type AgentConfig<
    TContext,
    TEvents extends { type: string },
    TStates extends StatesMap<TContext, TEvents>,
> = {
    id: string;
    initial: keyof TStates & string;
    context: TContext;
    events: TEvents;
    actions?: Readonly<Record<
        string,
        (args: { context: TContext; event: TEvents }) => Partial<TContext>
    >>;
    states: TStates;
};
