// Atlas — type contract for the XState agent wrapper.
//
// Spec: docs/specs/004-xstate-agent-wrapper.md §"Type contract"
//        + docs/specs/005-agent-deps-and-stringifiable-context.md
//        + docs/specs/006-modes-not-states.md
//
// This file is pure types + symbol declarations. Runtime construction lives in
// defineMode.ts / defineCompoundMode.ts / defineAgent.ts / compile.ts.
//
// Vocabulary (DD-024): a `Mode` is a leaf — one node in the agent's state tree
// with no sub-states; a `CompoundMode` is a Mode that contains sub-Modes.
// `defineMode` constructs the leaf; `defineCompoundMode` constructs the
// compound.

// ── JSON shape constraints (spec 005) ────────────────────────────────

/**
 * The primitive leaves that survive a `JSON.stringify` / `JSON.parse` round
 * trip without lossy encoding. `undefined` is admitted so optional fields
 * (`field?: T` → `T | undefined`) typecheck; at runtime `JSON.stringify`
 * silently drops keys whose value is `undefined`, which matches what every
 * persistence layer round-trips and avoids forcing `T | null` boilerplate.
 */
export type JsonPrimitive = string | number | boolean | null | undefined;

/**
 * Any JSON-compatible value: a primitive, an array of JSON values, or an
 * object whose values are JSON values. Exported as a building block for users
 * who want an open index-signature shape (e.g. `meta: JsonObject`).
 */
export type JsonValue = JsonPrimitive | JsonValue[] | { [k: string]: JsonValue };

/**
 * An open object whose values are `JsonValue`. Useful inside `TContext` when
 * the user wants a discriminated bag of arbitrary serializable telemetry.
 */
export type JsonObject = { [k: string]: JsonValue };

/**
 * An array of JSON values.
 */
export type JsonArray = JsonValue[];

/**
 * Recursive structural constraint — walks `T` and forces every leaf to be a
 * `JsonPrimitive`. Used at parameter-position rather than as a generic bound
 * (a `T extends JsonCompatible<T>` bound trips TypeScript's circular-
 * constraint detector). The wrapper applies it at the user-facing fields
 * that *receive* the data — `AgentConfig.context` and `CompoundContext.local`:
 *
 *     context: JsonCompatible<TContext>
 *
 * For a JSON-compatible `T`, `JsonCompatible<T>` is structurally equal to
 * `T`; the user's literal type-checks unchanged. For a `T` carrying a `Date`,
 * `Map`, function, etc., `JsonCompatible<T>` substitutes `never` at the
 * offending position — the user's literal then fails to assign with a
 * pinpoint error (`Type 'Date' is not assignable to type 'never'`).
 *
 * Distinct from `T extends JsonObject` because TypeScript does not treat a
 * closed object type (no index signature) as structurally assignable to
 * `{ [k: string]: JsonValue }`. Walking the declared shape directly lets
 * `{ messages: Message[] }` and
 * `interface AgentContext { messages: Message[] }` both pass.
 *
 * Rejected at compile time: `bigint`, `Date`, `Map`, `Set`, functions,
 * symbols, and any object or class type whose declared shape includes
 * methods/getters/setters (those members map through the function branch).
 * Data-only classes pass — the type system cannot distinguish them from
 * plain object literals, and `JSON.stringify` round-trips them identically.
 */
export type JsonCompatible<T> =
    T extends JsonPrimitive ? T :
    T extends ReadonlyArray<infer U> ? ReadonlyArray<JsonCompatible<U>> :
    T extends ReadonlyMap<unknown, unknown> | ReadonlySet<unknown> ? never :
    T extends (...args: never[]) => unknown ? never :
    T extends object ? { [K in keyof T]: JsonCompatible<T[K]> } :
    never;

// ── Outcomes & ModeOutput ────────────────────────────────────────────

/**
 * The three intentional outcomes a Mode's `behavior` can return:
 *
 * - **`"achieved"`** — the Mode's work succeeded. Dispatch via `routes.achieved`.
 * - **`"retry"`** — the Mode should run again on the same state (self-loop).
 *   Dispatch via `routes.retry`.
 * - **`"abandoned"`** — the Mode's work failed in an *expected* way (give up,
 *   not crash). Dispatch via `routes.abandoned`.
 *
 * A fourth outcome (`error`) exists, but it is **synthesized by the wrapper**
 * when `behavior` rejects — users never return it, and it is intentionally
 * absent from this union.
 */
export type Outcome = "achieved" | "retry" | "abandoned";

/**
 * The return type of an active Mode's `behavior`. The wrapper inspects
 * `outcome` to pick the right route bucket and threads `payload` into the
 * matched route's `when` / `assign` callbacks.
 *
 * @template TPayload  Shape of the payload. Constrains the inputs of all
 *                     `routes.*.when` and `routes.*.assign` callbacks on the
 *                     same Mode, so payload-driven dispatch stays type-safe.
 */
export type ModeOutput<TPayload = unknown> = {
    outcome: Outcome;
    payload: TPayload;
};

// ── Exit & re-throw tokens ───────────────────────────────────────────

/**
 * `END` — the only way for a route to leave a `CompoundMode`. Implemented as
 * a unique symbol so it cannot collide with state names (DD-015).
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
 * `modes` map; dotted paths, XState absolute paths (`#agent.foo`), and
 * descendant paths are NOT accepted (DD-016 / spec §"Target resolution").
 *
 * The type stays plain `string` because a Mode doesn't know its enclosing
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
 * - `when(payload)` — guard. Deps-free by design: routing decisions that need
 *   a dependency belong in `behavior`, not the routing layer (spec 005
 *   §Routes / EventHandlers).
 * - `target` — the destination state (sibling name or `END`).
 * - `assign({ context, payload, deps })` — return a `Partial<TContext>` to merge
 *   into context before the transition fires.
 *
 * @template TContext  Context shape visible to `assign`. Constrained to
 *                     `JsonCompatible<TContext>` for storage round-trip.
 * @template TPayload  Payload shape from `ModeOutput<TPayload>`.
 * @template TDeps     Frozen container of external resources, forwarded
 *                     verbatim from `defineAgent.deps`.
 */
export type ExitEntry<
    TContext,
    TPayload,
    TDeps extends Record<string, unknown> = Record<string, never>,
> = {
    when?: (payload: TPayload) => boolean;
    target: RouteTarget;
    assign?: (args: { context: TContext; payload: TPayload; deps: TDeps }) => Partial<TContext>;
};

/**
 * A single entry in `routes.retry`. **Has no `target`** — retry is always a
 * structural self-loop on the same Mode (DD-014). Supplying `target` here is
 * a compile error.
 *
 * - `when(payload)` — guard. Deps-free.
 * - `assign({ context, payload, deps })` — return a `Partial<TContext>` to merge
 *   into context before the self-transition fires.
 *
 * @template TContext  Context shape visible to `assign`.
 * @template TPayload  Payload shape from `ModeOutput<TPayload>`.
 * @template TDeps     Frozen deps container.
 */
export type RetryEntry<
    TContext,
    TPayload,
    TDeps extends Record<string, unknown> = Record<string, never>,
> = {
    when?: (payload: TPayload) => boolean;
    assign?: (args: { context: TContext; payload: TPayload; deps: TDeps }) => Partial<TContext>;
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
 * @template TDeps     Frozen deps container.
 */
export type ErrorEntry<
    TContext,
    TDeps extends Record<string, unknown> = Record<string, never>,
> = {
    when?: (error: unknown) => boolean;
    target: ErrorRouteTarget;
    assign?: (args: { context: TContext; error: unknown; deps: TDeps }) => Partial<TContext>;
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
 * The full route table for an active Mode — one bucket per `Outcome`, plus an
 * optional `error` bucket for synthesized errors.
 *
 * - **`achieved`** (required) — fired when `behavior` returns `outcome: "achieved"`.
 * - **`retry`** (required) — fired when `behavior` returns `outcome: "retry"`.
 *   Pass `readonly []` for "no special handling" (the wrapper just re-enters
 *   the same Mode).
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
 * @template TDeps     Frozen deps container, forwarded to every `assign`.
 */
export type Routes<
    TContext,
    TPayload,
    TDeps extends Record<string, unknown> = Record<string, never>,
> = {
    achieved:
        | ExitEntry<TContext, TPayload, TDeps>
        | RouteList<ExitEntry<TContext, TPayload, TDeps>>;
    retry:
        | RetryEntry<TContext, TPayload, TDeps>
        | readonly []
        | RouteList<RetryEntry<TContext, TPayload, TDeps>>;
    abandoned:
        | ExitEntry<TContext, TPayload, TDeps>
        | RouteList<ExitEntry<TContext, TPayload, TDeps>>;
    error?:
        | ErrorEntry<TContext, TDeps>
        | RouteList<ErrorEntry<TContext, TDeps>>;
};

/**
 * The route table for a `CompoundMode`. Same shape as `Routes` with two
 * differences (DD-025, spec 008 §`CompoundRoutes`):
 *
 * 1. **`retry` is constrained to `readonly []`** — shape symmetry with `Mode`
 *    only. A compound cannot bubble `retry`: children's `RetryEntry` has no
 *    `target` (DD-014), so `target: END` is structurally impossible inside
 *    `routes.retry`. The bucket exists so consumers reading a `CompoundMode`
 *    next to a `Mode` see the same four-key shape.
 * 2. **`error` is optional** — same semantics as `Mode.routes.error`: when
 *    omitted, an END rooted inside a child's `routes.error` re-throws above
 *    the compound (the existing "loud failure" default).
 *
 * The compound's outcome bucket is whichever bucket of the exiting child
 * contained `target: END`. `routes.achieved.when(payload)` and
 * `routes.abandoned.when(payload)` see the `TPayload` produced by the
 * compound's optional `output?` callback (or `undefined` when `output` is
 * omitted).
 *
 * @template TContext  Context shape visible to `assign` callbacks.
 * @template TPayload  Payload type produced by the compound's `output?`
 *                     callback; `undefined` when `output` is omitted.
 * @template TDeps     Frozen deps container, forwarded to every `assign`.
 */
export type CompoundRoutes<
    TContext,
    TPayload,
    TDeps extends Record<string, unknown> = Record<string, never>,
> = {
    achieved:
        | ExitEntry<TContext, TPayload, TDeps>
        | RouteList<ExitEntry<TContext, TPayload, TDeps>>;
    retry: readonly [];
    abandoned:
        | ExitEntry<TContext, TPayload, TDeps>
        | RouteList<ExitEntry<TContext, TPayload, TDeps>>;
    error?:
        | ErrorEntry<TContext, TDeps>
        | RouteList<ErrorEntry<TContext, TDeps>>;
};

// ── Event handlers (passive Mode) ────────────────────────────────────

/**
 * A single passive transition. Fired when the matching event arrives while
 * the Mode is active. For array-form handlers, first match wins (XState
 * semantics).
 *
 * - `target` — sibling name or `END`. Passive Modes CAN leave a compound on
 *   a particular event.
 * - `actions` — a name (or list of names) referencing entries declared in
 *   `defineAgent.actions`. **Inline callbacks are NOT accepted here** —
 *   that would re-introduce DD-004 churn.
 * - `guard({ context, event, deps })` — optional. The transition only fires
 *   when it returns true. `guard` already had access to mutable context;
 *   adding `deps` does not change what the callback can observe.
 *
 * @template TContext       Context shape visible to `guard`.
 * @template TEventVariant  The specific event variant this transition handles
 *                          (narrowed from `TEvents` by the discriminant key).
 * @template TDeps          Frozen deps container.
 */
export type EventTransition<
    TContext,
    TEventVariant,
    TDeps extends Record<string, unknown> = Record<string, never>,
> = {
    target?: RouteTarget;
    actions?: string | readonly string[];
    guard?: (args: { context: TContext; event: TEventVariant; deps: TDeps }) => boolean;
};

/**
 * The full `on` map for a passive Mode. Keys are event discriminants
 * (`event.type`); values are one transition or an ordered list of them. The
 * transition's `event` callback argument is automatically narrowed to the
 * matching event variant via `Extract<TEvents, { type: K }>`.
 *
 * @template TContext  Context shape visible to `guard`.
 * @template TEvents   The agent's full event union (each variant has a `type`).
 * @template TDeps     Frozen deps container.
 */
export type EventHandlers<
    TContext,
    TEvents extends { type: string },
    TDeps extends Record<string, unknown> = Record<string, never>,
> = {
    [K in TEvents["type"]]?:
        | EventTransition<TContext, Extract<TEvents, { type: K }>, TDeps>
        | readonly EventTransition<TContext, Extract<TEvents, { type: K }>, TDeps>[];
};

// ── Mode config (discriminated union) ────────────────────────────────

/**
 * Active Mode shape — runs an async `behavior` and dispatches on its
 * `ModeOutput`. Mutually exclusive with `PassiveModeConfig`; mixing
 * `behavior` and `on` in the same config is a compile error (DD-019).
 *
 * @template TContext  Context shape visible to `input` / `routes.*.assign`.
 * @template TEvents   Phantom — kept for symmetry with the passive variant.
 *                     Active Modes don't observe events directly.
 * @template TPayload  Payload type returned by `behavior` and threaded into
 *                     `routes.*.when` / `routes.*.assign`.
 * @template TDeps     Frozen deps container, available in `input` / `behavior`
 *                     / every `routes.*.assign`.
 */
export type ActiveModeConfig<
    TContext,
    TEvents extends { type: string },
    TPayload,
    TDeps extends Record<string, unknown> = Record<string, never>,
> = {
    input: (args: { context: TContext; deps: TDeps }) => unknown;
    behavior: (args: { input: unknown; deps: TDeps }) => Promise<ModeOutput<TPayload>>;
    routes: Routes<TContext, TPayload, TDeps>;
};

/**
 * Passive Mode shape — waits for external events. Mutually exclusive with
 * `ActiveModeConfig`.
 *
 * @template TContext  Context shape visible to `on[event].guard`.
 * @template TEvents   The agent's full event union.
 * @template TDeps     Frozen deps container, forwarded to every `on[*].guard`.
 */
export type PassiveModeConfig<
    TContext,
    TEvents extends { type: string },
    TDeps extends Record<string, unknown> = Record<string, never>,
> = {
    on: EventHandlers<TContext, TEvents, TDeps>;
};

/**
 * The discriminated union of Mode config shapes. TypeScript picks the variant
 * structurally — by which keys you supply.
 *
 * @template TContext  Context shape this Mode observes.
 * @template TEvents   The agent's full event union.
 * @template TPayload  Payload type for the active variant. Ignored by passive.
 * @template TDeps     Frozen deps container.
 */
export type ModeConfig<
    TContext,
    TEvents extends { type: string },
    TPayload,
    TDeps extends Record<string, unknown> = Record<string, never>,
> =
    | ActiveModeConfig<TContext, TEvents, TPayload, TDeps>
    | PassiveModeConfig<TContext, TEvents, TDeps>;

// ── Opaque mode markers ──────────────────────────────────────────────

// `Mode` and `CompoundMode` are opaque to user code — only `defineMode` and
// `defineCompoundMode` can produce values of these types. Internal shape
// (config, kind tag) is implementation detail of the wrapper; Phase 3's
// constructors attach the runtime payload behind the brand.
declare const __modeBrand: unique symbol;
declare const __compoundBrand: unique symbol;

/**
 * Opaque brand returned by `defineMode`. User code cannot inspect the
 * inside — the brand exists only so that `modes` slots reject anything
 * other than the output of `defineMode` / `defineCompoundMode`. The phantom
 * `__phantomMode` field preserves the covariant generic parameters; the
 * separate `__phantomDeps` field puts `TDeps` in function-argument position
 * so the brand is **contravariant** in `TDeps`. That gives the slot-time
 * variance check the right direction at no syntactic cost: a `Mode<…, A>`
 * is assignable to `Mode<…, B>` iff `B` is assignable to `A` — i.e. "the
 * agent provides at least every key the Mode asks for".
 *
 * @template TContext  Context shape this Mode observes.
 * @template TEvents   The agent's full event union.
 * @template TPayload  Payload type returned by the active variant's `behavior`.
 * @template TDeps     Frozen deps container the Mode demands.
 */
export interface Mode<
    TContext,
    TEvents extends { type: string },
    TPayload = unknown,
    TDeps extends Record<string, unknown> = Record<string, never>,
> {
    readonly [__modeBrand]: true;
    readonly __phantomMode?: {
        context: TContext;
        events: TEvents;
        payload: TPayload;
    };
    readonly __phantomDeps?: (deps: TDeps) => void;
}

/**
 * Opaque brand returned by `defineCompoundMode`. Same split-brand
 * contravariance for `TDeps` as `Mode`. User code cannot inspect the inside;
 * the brand only exists to constrain what `modes` slots accept.
 *
 * `TPayload` (DD-025) is the type produced by the compound's optional
 * `output?` callback. It threads into the enclosing scope's `routes.*.when`
 * dispatch when this compound itself is nested as a child of a parent
 * compound. Defaults to `unknown` so an explicitly-omitted `output` doesn't
 * have to be declared at every nesting level.
 *
 * @template TContext  Context shape provided by the enclosing scope.
 * @template TEvents   The agent's full event union.
 * @template TPayload  Payload type produced by `output?` (default `unknown`).
 * @template TDeps     Frozen deps container the compound demands.
 */
export interface CompoundMode<
    TContext,
    TEvents extends { type: string },
    TPayload = unknown,
    TDeps extends Record<string, unknown> = Record<string, never>,
> {
    readonly [__compoundBrand]: true;
    readonly __phantomCompound?: {
        context: TContext;
        events: TEvents;
        payload: TPayload;
    };
    readonly __phantomDeps?: (deps: TDeps) => void;
}

// ── Modes map (compound or agent level) ──────────────────────────────

/**
 * A `modes` map — used at the agent root and inside every `CompoundMode`.
 * Each slot is a `Mode` (leaf) or a nested `CompoundMode`. **Raw XState
 * configs are not accepted** — `defineMode` / `defineCompoundMode` are the
 * only way in.
 *
 * `TDeps` flows through to every slot, so a single `TDeps` declared at
 * `defineAgent` propagates down through every nested compound's slot map
 * without manual threading at the slot type level.
 *
 * @template TContext  Context shape visible to every slot in this map.
 * @template TEvents   The agent's full event union.
 * @template TDeps     Frozen deps container the enclosing scope provides.
 */
export type ModesMap<
    TContext,
    TEvents extends { type: string },
    TDeps extends Record<string, unknown> = Record<string, never>,
> = Readonly<Record<
    string,
    | Mode<TContext, TEvents, unknown, TDeps>
    | CompoundMode<TContext, TEvents, unknown, TDeps>
>>;

// ── Compound-local context (lexical scoping) ─────────────────────────

/**
 * Compound-local context declaration. Used as the optional `context` field on
 * `CompoundModeConfig` to narrow what children see.
 *
 * - **`inherit`** — list of keys from the enclosing context that are
 *   **live-mirrored** into this compound. Keys NOT in `inherit` are invisible
 *   to children at the type level.
 * - **`local`** — own variables declared at this compound. Initialized on
 *   entry and **reset on re-entry** (DD-018). Constrained to
 *   `JsonCompatible<TLocal>` because the slot is persisted as part of the
 *   root context.
 *
 * Children see `Pick<TParent, inherit[number]> & typeof local` as their
 * context.
 *
 * @template TParent   The enclosing context shape.
 * @template TInherit  A `readonly` tuple of string keys of `TParent`. Must be
 *                     literal (e.g. `["messages"] as const`) so the element
 *                     type is preserved exactly.
 * @template TLocal    The shape of declared local variables. Constrained to
 *                     `JsonCompatible<TLocal>` so persisted snapshots remain
 *                     JSON-safe.
 */
export type CompoundContext<
    TParent,
    TInherit extends ReadonlyArray<keyof TParent & string>,
    TLocal,
> = {
    inherit: TInherit;
    local: JsonCompatible<TLocal>;
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

// ── CompoundModeConfig & AgentConfig ─────────────────────────────────

/**
 * The config passed to `defineCompoundMode`. `initial` is typed as
 * `keyof TModes` so a typo here is a compile error.
 *
 * `context` is OPTIONAL. When present, children see only
 * `Pick<TParentContext, inherit[number]> & typeof local`; when omitted they
 * see the full `TParentContext`. See `defineCompoundMode` §"Lexical scoping".
 *
 * `output?` (DD-025, spec 008) is an OPTIONAL callback invoked when any child
 * routes to `END`, AFTER that child's `assign` has run. Its return value
 * becomes `event.output.payload` on the parent's `onDone` dispatch, available
 * to `routes.*.when` callbacks. When omitted, `TPayload` defaults to
 * `undefined` and `when(payload)` callbacks see `undefined`.
 *
 * `routes` (DD-025, spec 008) replaces the previous single `onDone:
 * RouteTarget` field. Same four-key shape as `Mode.routes`, with
 * `retry: readonly []` (shape symmetry only — compounds cannot bubble retry).
 * The compound's outcome bucket is whichever bucket of the exiting child
 * contained `target: END`. Passive `on[event].target = END` lowers to
 * `achieved` (default; spec 008 §"Outcome propagation rules").
 *
 * @template TParentContext  Context shape the enclosing scope provides.
 * @template TEvents         The agent's full event union.
 * @template TCtx            Either a `CompoundContext` literal or `undefined`.
 * @template TModes          The compound's `modes` map, typed against the
 *                           compound-local context view.
 * @template TPayload        Payload type produced by `output?`. Defaults to
 *                           `undefined` so omitting `output` requires no
 *                           explicit type argument.
 * @template TDeps           Frozen deps container. Flows to every slot.
 */
export type CompoundModeConfig<
    TParentContext,
    TEvents extends { type: string },
    // The upper bound here mirrors `CompoundContext`'s structural shape
    // without re-stating its self-referential `TLocal` constraint — that
    // check fires at the alias level when the user constructs the actual
    // `CompoundContext<TParent, TInherit, TLocal>` value they pass in.
    TCtx extends
        | {
            inherit: ReadonlyArray<keyof TParentContext & string>;
            local: object;
        }
        | undefined,
    TModes extends ModesMap<LocalContextOf<TParentContext, TCtx>, TEvents, TDeps>,
    TPayload = undefined,
    TDeps extends Record<string, unknown> = Record<string, never>,
> = {
    context?: TCtx;
    initial: keyof TModes & string;
    modes: TModes;
    output?: (args: {
        context: LocalContextOf<TParentContext, TCtx>;
        deps: TDeps;
    }) => TPayload;
    routes: CompoundRoutes<TParentContext, TPayload, TDeps>;
};

/**
 * The config passed to `defineAgent`. The root of the entire Mode tree.
 *
 * - **`id`** — XState machine id.
 * - **`initial`** — keyed against `TModes`; typo = compile error.
 * - **`context`** — the agent's root context literal. Constrained to
 *   `JsonCompatible<TContext>` so the snapshot round-trips through arbitrary
 *   storage without custom encoding (spec 005 §P5).
 * - **`events`** — phantom field; only its type matters. Pass `{} as TEvents`.
 * - **`deps`** (optional) — frozen container of external resources (DB
 *   driver, logger, LLM client). When omitted, `TDeps` defaults to
 *   `Record<string, never>` and callbacks see a frozen `{}`. Spec 005 §P6.
 * - **`actions`** (optional) — registers reusable, pure callbacks referenced
 *   by name from passive `on[event].actions`. Each callback returns
 *   `Partial<TContext>`; the wrapper applies `assign(...)` at compile time so
 *   user code never imports from `xstate`. The callback's `event` is typed
 *   as the full `TEvents` union — narrowing is the action body's job.
 * - **`modes`** — the root `modes` map.
 *
 * @template TContext  The agent's root context shape. JSON-constrained.
 * @template TEvents   The agent's full event union.
 * @template TModes    The root `modes` map.
 * @template TDeps     Frozen deps container.
 */
export type AgentConfig<
    TContext,
    TEvents extends { type: string },
    TModes extends ModesMap<TContext, TEvents, TDeps>,
    TDeps extends Record<string, unknown> = Record<string, never>,
> = {
    id: string;
    initial: keyof TModes & string;
    // JSON-shape enforcement happens here, at the field position rather than
    // as a generic bound: a `T extends JsonCompatible<T>` bound trips
    // TypeScript's circular-constraint detector. For a JSON-compatible
    // `TContext`, `JsonCompatible<TContext>` is structurally equal to
    // `TContext`; non-JSON shapes get `never` at offending positions and
    // fail to assign with a pinpoint error.
    context: JsonCompatible<TContext>;
    events: TEvents;
    deps?: Readonly<TDeps>;
    actions?: Readonly<Record<
        string,
        (args: { context: TContext; event: TEvents; deps: TDeps }) => Partial<TContext>
    >>;
    modes: TModes;
};
