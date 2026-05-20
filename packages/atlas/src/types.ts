// Atlas — type contract for the XState agent wrapper.
//
// Spec: docs/specs/004-xstate-agent-wrapper.md §"Type contract"
//
// This file is pure types + symbol declarations. Runtime construction lives in
// defineLeafMode.ts / defineMode.ts / defineAgent.ts / compile.ts.

// ── Outcomes & ModeOutput ────────────────────────────────────────────

// Three intentional outcomes — produced by `behavior`'s return. The fourth
// (`error`) is synthesized by the wrapper when `behavior` rejects; users
// never return it and `ModeOutput.outcome` does NOT include it.
export type Outcome = "achieved" | "retry" | "abandoned";

export type ModeOutput<TPayload = unknown> = {
    outcome: Outcome;
    payload: TPayload;
};

// ── Exit & re-throw tokens ───────────────────────────────────────────

// END — the only way for a route to leave a compound mode. Implemented as a
// unique symbol so it cannot collide with state names.
export const END: unique symbol = Symbol("atlas.END");
export type END = typeof END;

// RE_THROW — error-only target that re-propagates the caught rejection above
// the actor instead of transitioning. Lets `routes.error` filter out
// programmer errors (TypeError, etc.) without putting `throw` inside `assign`.
// Valid ONLY on `ErrorEntry.target`.
export const RE_THROW: unique symbol = Symbol("atlas.RE_THROW");
export type RE_THROW = typeof RE_THROW;

// ── Targets ──────────────────────────────────────────────────────────

// Targets for `achieved` / `abandoned` entries — sibling name or END. The
// `string` here means a sibling state name in the immediate enclosing
// `states` map; dotted paths, XState absolute paths (`#agent.foo`), and
// descendant paths are NOT accepted (see §"Target resolution"). The type
// stays `string` because the leaf doesn't know its enclosing states at
// definition time — the wrapper's compile step validates against the actual
// sibling set and throws on machine creation.
export type RouteTarget = string | END;

// Targets for `error` entries — additionally accepts RE_THROW.
export type ErrorRouteTarget = string | END | RE_THROW;

// ── Route entries ────────────────────────────────────────────────────

// achieved / abandoned entries — carry a target.
export type ExitEntry<TContext, TPayload> = {
    when?: (payload: TPayload) => boolean;
    target: RouteTarget;
    assign?: (args: { context: TContext; payload: TPayload }) => Partial<TContext>;
};

// retry entries — no target (retry is always a self-loop on the leaf).
// Supplying `target` here is a compile error.
export type RetryEntry<TContext, TPayload> = {
    when?: (payload: TPayload) => boolean;
    assign?: (args: { context: TContext; payload: TPayload }) => Partial<TContext>;
};

// error entries — fired when `behavior` throws / its Promise rejects. The
// wrapper catches the rejection, synthesizes the outcome, and routes through
// these entries. `when` and `assign` receive the raw error.
// `target: RE_THROW` re-propagates the error; `assign` is ignored on
// RE_THROW entries (re-throwing is the side effect).
export type ErrorEntry<TContext> = {
    when?: (error: unknown) => boolean;
    target: ErrorRouteTarget;
    assign?: (args: { context: TContext; error: unknown }) => Partial<TContext>;
};

// ── RouteList<E> — "first match wins, last entry is the default" ─────

// Encodes the array-form rule at the TYPE level. Non-last entries are
// required to carry `when`; the last entry must omit it. This makes the
// misplacement of `when` (an unguarded entry shadowing later entries —
// dead code at runtime) a compile error rather than a silent routing bug.

// WithWhen<E> — promote optional `when` to required.
export type WithWhen<E> = E extends { when?: infer W }
    ? Omit<E, "when"> & { when: NonNullable<W> }
    : E;

// NoWhen<E> — strip `when` (the default's `when` must not be present, even
// as `undefined`).
export type NoWhen<E> = Omit<E, "when">;

// Single-entry array: just the default. Multi-entry: one or more guarded
// entries followed by the default. `[]` is unrepresentable — the type
// system rejects it for `achieved` / `abandoned` / `error`. `retry` permits
// `readonly []` separately as the "no special handling" shorthand.
export type RouteList<E> =
    | readonly [NoWhen<E>]
    | readonly [WithWhen<E>, ...readonly WithWhen<E>[], NoWhen<E>];

// ── Routes — the four-key map ────────────────────────────────────────

// achieved / retry / abandoned are MANDATORY. error is OPTIONAL: when
// omitted, the wrapper re-throws the rejection above the actor. This is the
// only safe default — omitting `error` must not silently swallow a failure.
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

// One transition. `target` accepts a sibling name or END (passive modes
// CAN exit a compound on a particular event); `actions` is a name (or list
// of names) referencing entries declared in `defineAgent.actions`. Inline
// callbacks are NOT accepted here — that would re-introduce DD-004 churn.
// `guard` is optional; when present, the transition only fires if it
// returns true. For array form, first match wins (XState semantics).
export type EventTransition<TContext, TEventVariant> = {
    target?: RouteTarget;
    actions?: string | readonly string[];
    guard?: (args: { context: TContext; event: TEventVariant }) => boolean;
};

// Map from event discriminant (`event.type`) to one transition or an
// ordered list of transitions. The transition's `event` callback argument
// is narrowed to the matching event variant via `Extract<E, { type: K }>`.
export type EventHandlers<TContext, TEvents extends { type: string }> = {
    [K in TEvents["type"]]?:
        | EventTransition<TContext, Extract<TEvents, { type: K }>>
        | readonly EventTransition<TContext, Extract<TEvents, { type: K }>>[];
};

// ── LeafMode config (discriminated union) ────────────────────────────

// Active variant: `input` + `behavior` + `routes`. The two variants are
// mutually exclusive at the type level — using `behavior` and `on` in the
// same config is a compile error.
export type ActiveLeafModeConfig<TContext, TEvents extends { type: string }, TPayload> = {
    input: (args: { context: TContext }) => unknown;
    behavior: (args: { input: unknown }) => Promise<ModeOutput<TPayload>>;
    routes: Routes<TContext, TPayload>;
};

// Passive variant: `on` only.
export type PassiveLeafModeConfig<TContext, TEvents extends { type: string }> = {
    on: EventHandlers<TContext, TEvents>;
};

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

export interface LeafMode<
    TContext,
    TEvents extends { type: string },
    TPayload = unknown,
> {
    readonly [__leafBrand]: true;
    // Phantom field — preserves generic parameters for inference at slot sites.
    readonly __phantomLeaf?: {
        context: TContext;
        events: TEvents;
        payload: TPayload;
    };
}

export interface Mode<TContext, TEvents extends { type: string }> {
    readonly [__modeBrand]: true;
    readonly __phantomMode?: {
        context: TContext;
        events: TEvents;
    };
}

// ── States map (compound or agent level) ─────────────────────────────

// A state slot in a compound or agent — either a leaf mode or a nested
// compound. Raw XState configs are NOT accepted — this is the only way to
// populate `states`.
export type StatesMap<TContext, TEvents extends { type: string }> = Readonly<Record<
    string,
    LeafMode<TContext, TEvents> | Mode<TContext, TEvents>
>>;

// ── Compound-local context (lexical scoping) ─────────────────────────

// `inherit` lists keys from the enclosing context that are live-mirrored
// into this compound; `local` declares own variables initialized on entry
// and reset on re-entry. Children see `Pick<TParent, inherit[number]> &
// typeof local` as their context — keys not in `inherit` are invisible at
// the type level.
//
// `TInherit` must be a `readonly` tuple of string keys of `TParent` so the
// element type is preserved literally (e.g. `["messages"] as const`).
export type CompoundContext<
    TParent,
    TInherit extends ReadonlyArray<keyof TParent & string>,
    TLocal extends object,
> = {
    inherit: TInherit;
    local: TLocal;
};

// Effective context the compound's children see. Omitting `context`
// (TCtx = undefined) keeps the full enclosing context visible — no
// narrowing, no locals.
export type LocalContextOf<TParent, TCtx> =
    TCtx extends CompoundContext<TParent, infer I, infer L>
        ? Pick<TParent, I[number] & keyof TParent> & L
        : TParent;

// ── ModeConfig & AgentConfig ─────────────────────────────────────────

// `initial` is typed as `keyof TStates` so a typo here is a compile error.
// `onDone` is the parent transition target fired when any child routes to
// `END`. It accepts a sibling name OR `END` (when the compound itself is
// nested inside another).
//
// `context` is OPTIONAL. When present, children see only
// `Pick<TParentContext, inherit[number]> & typeof local`; when omitted they
// see the full `TParentContext`. See §`defineMode` "Lexical scoping".
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

// `events` is a phantom field — only its type matters. Pass `{} as TEvents`.
//
// `actions` registers reusable, pure callbacks referenced by name from
// passive `on[event].actions`. Each callback returns `Partial<TContext>`;
// the wrapper applies `assign(...)` at compile time so user code never
// imports from `xstate`. The callback's `event` is typed as the full
// `TEvents` union — narrowing is the action body's responsibility.
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
