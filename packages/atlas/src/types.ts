// Atlas — type contract for the mode-based agent orchestration library.
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

// ── Result: outcome (LEAVE) XOR stay (STAY) ──────────────────────────

// SPEC 011 §The model: the behavior's return value has two natures.

/**
 * SPEC 011: the two **LEAVE** outcomes — a judgement on the mode's goal. Each
 * is dispatched by `routes` and carries a `target`.
 *
 * - **`"achieved"`** — the goal was met. Dispatch via `routes.achieved`.
 * - **`"abandoned"`** — the work gave up in an *expected* way (not a crash).
 *   Dispatch via `routes.abandoned`.
 *
 * A third bucket (`error`) is **synthesized by the wrapper** when `behavior`
 * rejects — users never return it, and it is absent from this union.
 */
export type Outcome = "achieved" | "abandoned";

/**
 * SPEC 011: the two **STAY** continuations — remain in the mode and re-run the
 * behavior. Neither carries a `target`; both are dispatched by `stay`.
 *
 * - **`"replay"`** — re-run immediately (active: no event; passive: the same event).
 * - **`"waitOnEvent"`** — re-run when the next declared event arrives.
 */
export type Stay = "replay" | "waitOnEvent";

/**
 * SPEC 011 §Surface: the behavior speaks ONLY through this return value — a
 * union of two natures, LEAVE (`outcome`) XOR STAY (`stay`). The XOR is
 * enforced with `?: never` on the opposite discriminant so the two cannot be
 * mixed: a plain key-presence union would let `{ outcome, stay }` through
 * (excess-property checking treats both as "known" keys of the union).
 *
 * @template TPayload  Payload threaded into the matched `routes` / `stay`
 *                     bucket's `assign` (and `routes.*.when`).
 */
export type ModeResult<TPayload = unknown> =
    | { outcome: Outcome; stay?: never; payload: TPayload }
    | { stay: Stay; outcome?: never; payload: TPayload };

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
 * SPEC 011 §The model: the config for a STAY continuation
 * (`stay.replay` / `stay.waitOnEvent`). **Has no `target`** — staying re-runs
 * THIS mode's behavior (the old `retry` self-loop, DD-014, generalized). No
 * `when`: the behavior already chose the continuation, so there is no
 * payload-guard. `assign` runs before the re-run.
 *
 * @template TContext  Context shape visible to `assign`.
 * @template TPayload  Payload shape from `ModeResult<TPayload>`.
 * @template TDeps     Frozen deps container.
 */
export type StayEntry<
    TContext,
    TPayload,
    TDeps extends Record<string, unknown> = Record<string, never>,
> = {
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

// ── Routes (exits) & StayMap (continuations) ─────────────────────────

/**
 * SPEC 011 §The model — `routes` holds ONLY exits: the two LEAVE outcomes, each
 * carrying a `target` (the SDK-goal completion / abandonment criteria), plus an
 * optional synthesized `error` bucket. `retry` is gone — continuations live in
 * `StayMap`, not under a key called "routes".
 *
 * - **`achieved`** (required) — fired when `behavior` returns `outcome: "achieved"`.
 * - **`abandoned`** (required) — fired when `behavior` returns `outcome: "abandoned"`.
 * - **`error`** (optional) — fired when `behavior` throws. **When omitted, the
 *   wrapper re-throws above the actor** (spec 010 `onError`). Never swallowed.
 *
 * Each bucket accepts a single entry or a `RouteList` (first-match-wins array).
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
    abandoned:
        | ExitEntry<TContext, TPayload, TDeps>
        | RouteList<ExitEntry<TContext, TPayload, TDeps>>;
    error?:
        | ErrorEntry<TContext, TDeps>
        | RouteList<ErrorEntry<TContext, TDeps>>;
};

/**
 * SPEC 011 §The model — `stay` holds ONLY continuations: remain in the mode and
 * re-run the behavior. No `target`. Optional everywhere (a mode that never
 * stays omits it). Each bucket is a single `StayEntry` (assign only).
 *
 * - **`replay`** — re-run now (active: no event; passive: the same event).
 * - **`waitOnEvent`** — re-run when the next declared event arrives.
 *
 * @template TContext  Context shape visible to `assign`.
 * @template TPayload  Payload type returned by `behavior`.
 * @template TDeps     Frozen deps container, forwarded to every `assign`.
 */
export type StayMap<
    TContext,
    TPayload,
    TDeps extends Record<string, unknown> = Record<string, never>,
> = {
    replay?: StayEntry<TContext, TPayload, TDeps>;
    waitOnEvent?: StayEntry<TContext, TPayload, TDeps>;
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
    // SPEC 011: no `retry` — compounds have no `behavior`, so no continuations.
    abandoned:
        | ExitEntry<TContext, TPayload, TDeps>
        | RouteList<ExitEntry<TContext, TPayload, TDeps>>;
    error?:
        | ErrorEntry<TContext, TDeps>
        | RouteList<ErrorEntry<TContext, TDeps>>;
};

// ── Mode config (unified — start: "run" | "event") ───────────────────

// SPEC 011 §The model + §Surface. There are no more `on`-only passive leaves
// and no `EventHandlers` map: EVERY mode has a `behavior`. How a mode is
// activated is a single bit, `start`: "run" (default) enters by running the
// behavior immediately; "event" enters parked and runs on a declared event.
// The ONLY type difference is the behavior's `event` parameter. This **revokes
// DD-019** (the behavior/on mutual exclusion) and un-phantoms `TEvents`.

/**
 * SPEC 011: the fields shared by both kinds — everything except the behavior's
 * `event` type.
 *
 * - `input` — derive the behavior's input from context (+ deps).
 * - `events?` — the event types this mode may wait/replay on (drives `stay`).
 * - `routes` — the two exits (target + assign).
 * - `stay?` — the two continuations (assign only).
 *
 * @template TContext  Context shape this mode observes.
 * @template TEvents   The agent's full event union (no longer phantom).
 * @template TPayload  Payload returned by `behavior`.
 * @template TDeps     Frozen deps container.
 */
export type CommonModeConfig<
    TContext,
    TEvents extends { type: string },
    TPayload,
    TDeps extends Record<string, unknown> = Record<string, never>,
> = {
    input: (args: { context: TContext; deps: TDeps }) => unknown;
    events?: readonly TEvents["type"][];
    routes: Routes<TContext, TPayload, TDeps>;
    stay?: StayMap<TContext, TPayload, TDeps>;
};

/**
 * SPEC 011: `start: "run"` (default) — the mode enters by RUNNING the behavior
 * immediately (no event yet, `event: undefined`); `replay` re-runs with no
 * event. `start` is optional (run is the default).
 */
export type RunModeConfig<
    TContext,
    TEvents extends { type: string },
    TPayload,
    TDeps extends Record<string, unknown> = Record<string, never>,
> = CommonModeConfig<TContext, TEvents, TPayload, TDeps> & {
    start?: "run";
    behavior: (args: {
        input: unknown;
        event: TEvents | undefined;
        deps: TDeps;
    }) => Promise<ModeResult<TPayload>>;
};

/**
 * SPEC 011: `start: "event"` — the mode enters by PARKING; the behavior runs
 * only when a declared event arrives, so `event` is never `undefined` (no
 * guard). `replay` keeps the same event; `waitOnEvent` swaps for the next.
 */
export type EventModeConfig<
    TContext,
    TEvents extends { type: string },
    TPayload,
    TDeps extends Record<string, unknown> = Record<string, never>,
> = CommonModeConfig<TContext, TEvents, TPayload, TDeps> & {
    start: "event";
    behavior: (args: {
        input: unknown;
        event: TEvents;
        deps: TDeps;
    }) => Promise<ModeResult<TPayload>>;
};

/**
 * SPEC 011: the union of the two mode shapes, discriminated by `start`.
 * `defineMode` resolves it via overloads — the event variant's required
 * `start: "event"` is the more specific match.
 *
 * @template TContext  Context shape this Mode observes.
 * @template TEvents   The agent's full event union.
 * @template TPayload  Payload type returned by `behavior`.
 * @template TDeps     Frozen deps container.
 */
export type ModeConfig<
    TContext,
    TEvents extends { type: string },
    TPayload,
    TDeps extends Record<string, unknown> = Record<string, never>,
> =
    | RunModeConfig<TContext, TEvents, TPayload, TDeps>
    | EventModeConfig<TContext, TEvents, TPayload, TDeps>;

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
 *   entry and **reset on re-entry** (DD-018), but **NOT** reset on snapshot
 *   restore: when an actor is rehydrated via `startAgent({ snapshot })`,
 *   the persisted slot wins over the entry-reset (spec 009 §Persistence
 *   Contract). Constrained to `JsonCompatible<TLocal>` so the slot is
 *   JSON-safe — required for snapshot serialization.
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
 * - **`id`** — stable identifier for this agent.
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

declare const agentBrand: unique symbol;

/**
 * Opaque handle to a compiled agent — the value `defineAgent` returns and
 * `startAgent` consumes (spec 012 §Seam 1, DD-030).
 *
 * Atlas owns this seam: the carrier machine is hidden behind an Atlas brand so
 * no consumer-facing signature mentions the underlying engine. Feeding this to
 * the carrier's own boot API does not typecheck — `startAgent` is the only door.
 *
 * `TContext`/`TEvents` are carried **invariantly** via `__phantomAgent`
 * (function-in AND function-out), so `startAgent(agent)` infers both from the
 * brand and the explicit `startAgent<Ctx, Ev>(agent)` form is cross-checked
 * against it (a mismatch is a compile error, not silently-wrong types).
 *
 * @template TContext  The agent's root context shape.
 * @template TEvents   The agent's full event union.
 */
export type Agent<TContext, TEvents extends { type: string }> = {
    readonly [agentBrand]: true;
    // Invariant phantom (function position in AND out), mirroring the
    // `__phantomDeps` technique on `Mode` — not a covariant property slot.
    readonly __phantomAgent?: (io: { context: TContext; events: TEvents })
        => { context: TContext; events: TEvents };
    /** The compiled carrier machine. Opaque: typed `unknown` on purpose so no
     *  engine type crosses the seam. Unwrapped only inside `startAgent`. */
    readonly carrier: unknown;
};

// ── Atlas actor surface (spec 009) ───────────────────────────────────

/**
 * Atlas-vocabulary observation event. Phase 1 emits only `transition`.
 *
 * - `from` / `to` are mode-paths formatted by `formatModePath` (dot-joined,
 *   parent first). Hosts no longer parse XState's nested `snapshot.value`
 *   shape directly.
 * - `context` is the root `TContext` AFTER the transition's assigns have
 *   run.
 * - `awaiting` (SPEC 011 Clarification #6) — readiness, surfaced explicitly
 *   rather than inferred from the (now-masked) path. Present and **non-empty**
 *   ONLY when the agent is parked in a mode's `$wait` substate; it lists the
 *   event types that will resume the agent. Absent/`undefined` while the agent
 *   is running (`$run`). Typed as `readonly string[]` rather than the agent's
 *   `TEvents["type"]` union because `AgentInspectionEvent` is not threaded with
 *   `TEvents` — keeping the readiness signal a flat list of event-type strings
 *   avoids propagating a new generic through the whole actor surface.
 */
export type AgentInspectionEvent<TContext> = {
    type: "transition";
    from: string;
    to: string;
    context: TContext;
    awaiting?: readonly string[];
};

declare const agentSnapshotBrand: unique symbol;
declare const persistedBrand: unique symbol;

/**
 * Opaque, Atlas-owned persisted payload (spec 012 §Seam 2, DD-032). The
 * concrete v2 shape is `{ atlasVersion: "2", value, context }` — an
 * Atlas-defined, carrier-neutral descriptor — but it is **branded opaque** so
 * hosts can type their storage layer (`PersistedAgentSnapshot`) without
 * depending on the inside. Persist `JSON.stringify(...)` and restore with
 * `JSON.parse(...)` at the storage boundary; do not read its fields.
 */
export type PersistedAgentSnapshot = {
    readonly [persistedBrand]: true;
};

/**
 * Opaque persisted agent state. Returned by `actor.getSnapshot()`; fed back
 * to `startAgent({ snapshot })` next turn. The `TContext` parameter is brand-
 * only (phantom) — used so a snapshot from agent A cannot be passed to
 * `startAgent` for an agent whose `TContext` shape differs.
 *
 * - `atlasVersion` is the dispatch key (spec 012 DD-032): the current schema
 *   is `"2"`. Payloads stamped with an older version hit the mismatch path on
 *   restore (soft reset to `initial`).
 * - `persisted` is the Atlas-owned opaque payload — treat it as a blob:
 *   `JSON.stringify` it to durable storage and `JSON.parse` it back.
 */
export type AgentSnapshot<TContext> = {
    readonly atlasVersion: string;
    readonly persisted: PersistedAgentSnapshot;
    readonly [agentSnapshotBrand]?: (_: TContext) => TContext;
};

/**
 * Started Atlas actor. Auto-started by `startAgent`; call `stop()` to
 * dispose. Use `inspect` at construction time for observation; build any
 * readiness gates the host needs from that callback.
 */
export type AgentActor<TContext, TEvents extends { type: string }> = {
    send: (event: TEvents) => void;
    stop: () => void;
    getSnapshot: () => AgentSnapshot<TContext>;
};

/**
 * Payload delivered to `StartAgentOptions.onError` when a rejection escapes
 * the machine — i.e. `behavior` rejected and either `routes.error` was
 * absent, no `routes.error` entry's `when` matched, or a matched entry
 * targeted `RE_THROW`. See spec 010 §Behavior Contract.
 *
 * - `error` — the raw rejection value. Typed as `unknown` because
 *   `behavior` is a user-controlled `async` function whose rejection value
 *   can be anything; narrowing is the host's job.
 * - `modePath` — dot-joined path of the leaf whose `behavior` rejected,
 *   formatted by the same `formatModePath` used by `inspect.transition`.
 * - `context` — root context at the moment the rejection became fatal
 *   (i.e. after any matched `routes.error.assign` ran).
 * - `snapshot` — the agent snapshot at the moment of error, suitable for
 *   persistence. Captured synchronously inside the error subscriber, before
 *   the actor's terminal state is observable to `send`. Feeding it to a
 *   fresh `startAgent({ snapshot })` re-enters the failed leaf — hosts
 *   that want to "fire-and-log and keep listening" persist the *prior*
 *   turn's snapshot instead (spec 010 §Recommended host pattern).
 */
export type AgentErrorInfo<TContext> = {
    error: unknown;
    modePath: string;
    context: TContext;
    snapshot: AgentSnapshot<TContext>;
};

/**
 * Options accepted by `startAgent`.
 *
 * - `snapshot` — persisted state from a previous turn. When omitted, the
 *   machine boots into its `initial` state. When present, the persisted
 *   slot for every compound `local` survives `entry`-reset (spec 009
 *   §Persistence Contract).
 * - `inspect` — construction-time callback receiving Atlas-vocabulary
 *   events. Phase 1 emits only `transition`.
 * - `onError` — construction-time callback fired when a rejection escapes
 *   the machine's declarative recovery (`routes.error`). Strictly
 *   additive: when omitted, the wrapper makes no `subscribe` call and
 *   current Node `unhandledRejection` propagation is preserved
 *   (spec 010 §Behavior Contract).
 */
export type StartAgentOptions<TContext> = {
    snapshot?: AgentSnapshot<TContext>;
    inspect?: (event: AgentInspectionEvent<TContext>) => void;
    onError?: (info: AgentErrorInfo<TContext>) => void;
};
