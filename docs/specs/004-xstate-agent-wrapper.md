# 004 — XState Agent Wrapper

## Goal

Introduce a thin wrapper over XState v5 — published as the `atlas` package — that removes the placement frictions identified in the design decisions and the README "Takeaways" section, while preserving every guarantee XState provides. The wrapper does not replace XState — it compiles down to a standard `setup().createMachine()` and the runtime, types, and inspector behavior are unchanged. The library is designed to grow into a small orchestration layer for AI agents (per-mode LLM configuration, observability hooks), but this spec only covers the foundation that makes those extensions possible.

This spec defines the public API, the mapping from wrapper concepts to XState concepts, the monorepo restructure needed to host the package, and the extension seams that future specs will use. **No agent behavior changes are introduced by the rewrite itself.** The current Atlas agent is renamed to `zoe` and moved under `examples/zoe/`, but its observable outputs and tests remain identical. The migration deliberately stops short of the **entire `socratic` compound**: `socratic.evaluating`'s spec-003 retry semantic (a sideways jump back to `teaching`) does not map onto the wrapper's self-loop retry, and migrating only the other socratic substates would force the compound to mix wrapped and raw XState nodes — which the wrapper rejects on principle (see §Migration steps step 4 for the two paths forward, both behavior changes belonging to a follow-up spec on top of 003).

## Problems Addressed

Each problem maps to one or more design decisions (DD-XXX) or to the README "What doesn't" section.

### P1 — Actor/state separation forced by `setup().actors`

**Source:** README §"Invoke actors are separated from the states they belong to" + DD-008 + DD-009.

XState v5 requires actors to be registered in `setup().actors` and then referenced from `invoke.src` by string. The actor's definition lives at the top of the file; the state that invokes it lives inside `createMachine()`. In the agent model (DD-002), a state's invoked actor *is* the agent's behavior in that state — these are conceptual pairs forced apart by the API. The current mitigation (naming convention from DD-008 + dedicated state files from DD-009) helps readability but leaves three real costs: a string lookup that can drift silently, manual registration in `setup().actors`, and a name that the human has to keep in sync with the state path.

### P2 — Boilerplate around `ModeOutput<T>` routing

**Source:** DD-010 + DD-011 + spec 003 §"ModeOutput — Universal Actor Return Type".

Every actor returns `ModeOutput<T>`, and every state that invokes it writes the same shape of guarded `onDone`:

```ts
onDone: [
    { guard: ({ event }) => event.output.outcome === "achieved", target: "done" },
    { guard: ({ event }) => event.output.outcome === "abandoned", target: "done" },
    { target: "teaching" },
]
```

The pattern is intentional and stays inline (DD-010 rejects moving guards to `setup()`), but it is verbose, untyped (`event.output` is `unknown` without manual casts — see `src/machine.ts:91`), and the `assign` that appends `payload.messages` to context repeats in every mode that produces messages.

### P3 — Tripla prompt+tools+actor unifiable but not codified

**Source:** DD-009.

DD-009 establishes that the system prompt, the tools, and the actor are inseparable — they together define what the agent does in a mode. Today the file groups them by convention; the API does not. There is no construct in the codebase that says "these three things are one unit". A future migration of a mode to a different LLM provider has to touch the actor, the state, and the registration separately.

### P4 — Type-erased flow between actor output and `assign`

**Source:** `src/machine.ts:91,116,170` — every `onDone.actions: assign(...)` has to cast `event.output` to `ModeOutput<{ messages: Message[] }>` because `setup().actors` does not propagate the actor's return type to the guard/assign callbacks. This silently breaks if the actor's payload shape changes.

## Non-Goals (in scope for the wrapper, out of scope for this spec)

The wrapper is being built with these features in mind. The API surface in this spec must accommodate them, but **implementing** them is explicitly deferred to follow-up specs:

- **Per-mode LLM configuration.** Different model, temperature, or provider per mode.
- **Middleware / lifecycle hooks.** `onEnter` / `onExit` / `onToolCall` for tracing, telemetry, audit.
- **Composable behavior policies.** Retry budgets, timeout policies, fallback chains.
- **Streaming responses.** Token-by-token output piped to stdout.
- **CompoundMode catalog / dynamic registration.** Loading modes from a manifest at runtime.

For each, this spec calls out the **extension seam** — the place in the wrapper's design where the feature will plug in — but no implementation. Future specs will fill those seams.

## Public API

The wrapper exports three constructors (`defineCompoundMode`, `defineMode`, `defineAgent`), the `END` exit token, and re-exports `ModeOutput<T>`.

### `defineCompoundMode` — a mode with internal substates

A compound mode owns multiple substates (e.g. `socratic` with `teaching` / `listening` / `evaluating`). It is a thin wrapper around XState's compound state. The user **never declares a final substate** — the wrapper injects one and routes through it whenever a child targets `END`.

```ts
export const socratic = defineCompoundMode({
    // Compound-local context (optional). When present, the compound's
    // children (leaves and nested compounds) see ONLY what is declared
    // here — keys not listed in `inherit` are invisible inside this
    // compound (compile error to access). Omitting `context` keeps the
    // full enclosing context visible — that is the default.
    context: {
        // Keys live-mirrored from the enclosing context. Reads return
        // the current parent value; writes from leaves pass through
        // to the parent synchronously in the same step (no entry/exit
        // lift-and-project).
        inherit: ["messages"] as const,
        // Local-only variables. Initialized to the declared shape on
        // every entry to this compound and **reset on re-entry**.
        // Invisible to siblings and to the parent.
        local: { attempts: 0 },
    },
    initial: "teaching",
    modes: {
        teaching:   socraticTeaching,      // defineMode (active)
        listening:  socraticListening,     // defineMode (passive)
        evaluating: socraticEvaluating,    // defineMode (active)
        // No `done` declared. The wrapper injects a final substate and binds
        // `END` (used by children's routes) to it.
    },
    // Fires when any child routes to `END`. Same semantic as XState's `onDone`
    // on a compound state, expressed in terms of the wrapper's exit token.
    onDone: "classifying",
});
```

`modes` accepts exactly two node kinds:

1. A `CompoundMode` (from `defineCompoundMode` — i.e. another compound; nesting is unbounded).
2. A `Mode` (from `defineMode` — either active or passive variant; see next section).

No raw XState configs. Anything the agent needs is expressible through these two primitives plus `END`; if that ever stops being true, the gap is a wrapper bug to fix, not an escape hatch to widen.

#### Lexical scoping of context

`context` is the wrapper's answer to nested compounds that would otherwise have to pollute the agent's root context with mode-local data (see §Common Patterns "Retry budget" for the canonical use). Semantics:

- **Slice (`inherit`).** A read-write window onto the enclosing context. Reads return the current parent value; writes propagate to the parent in the same step. No copy on entry, no project-back on exit — the children write through.
- **Local (`local`).** Own variables initialized on entry, scoped to this compound, **reset on re-entry**. They survive between substate transitions within the same activation, but a fresh entry (e.g. after `onDone` fires and the parent re-routes back) starts them from the declared shape again.
- **Visibility.** Children (leaves and nested compounds) see context typed as `Pick<TParent, inherit[number]> & typeof local`. Anything not in `inherit` is invisible — accessing it inside a child's `input` or `assign` is a compile error.
- **Nesting.** A `CompoundMode` nested inside another `CompoundMode` scopes its `inherit` against the **immediate** enclosing compound's local context, not the agent root. Locals are private to each level.

### `defineMode` — an agent mode (active or passive)

A leaf mode is a terminal state in the agent's lifecycle (DD-002) — no children, no nested submachine. The wrapper accepts both shapes through a single constructor backed by a TypeScript discriminated union — the compiler enforces that the two variants are mutually exclusive.

- **Active mode** — the agent is doing work. Has `input`, `behavior` (the invoked actor returning `ModeOutput<T>`), and `routes`. Covers `greetings.thinking`, `improvising.thinking`, and `classifying` in the migration scope of this spec; `socratic.teaching` and `socratic.evaluating` are the same shape but stay in raw XState here (see §Migration steps step 4).
- **Passive mode** — the agent is waiting for an event. Has only `on:` (event handlers). Covers the root `listening`; `socratic.listening` is the same shape but stays in raw XState here (see §Migration steps step 4).

The reader distinguishes the two by which fields are present; the constructor name stays uniform with DD-002 ("each state is a mode").

```ts
import { defineMode, END } from "atlas";

// ── ACTIVE form ──────────────────────────────────────────────────────
export const greetingsThinking = defineMode<
    AgentContext,
    AgentEvents,
    { messages: Message[] }   // payload type
>({
    // `input` derives the actor's typed input from the machine's context.
    // Same role as XState's `invoke.input`.
    input: ({ context }) => ({ messages: context.messages }),

    // `behavior` returns `ModeOutput<TPayload>` with one of three intentional
    // outcomes (achieved | retry | abandoned). It may also throw / reject —
    // the wrapper catches that and routes it as a fourth outcome (`error`)
    // through `routes.error`. The user does NOT wrap the return in
    // `Result<>`; throwing is the normal escape path.
    // Side effects (printing the reply) live here per DD-011.
    behavior: async ({ input }) => {
        const messages = await chat(input.messages, SYSTEM_PROMPT);
        printAssistant(messages.at(-1));
        return { outcome: "achieved", payload: { messages } };
    },

    // `routes` is a map keyed by outcome. All FOUR keys are mandatory.
    // `achieved` and `abandoned` carry a `target`; `retry` does NOT — it is
    // always a self-loop on the leaf. `error` carries a `target` like
    // achieved/abandoned, but its `when` and `assign` callbacks receive
    // `error: unknown` instead of `payload`. Each value is a single entry
    // or a non-empty array discriminated by `when(...)`.
    routes: {
        achieved: {
            // `target` accepts a sibling state name OR the `END` symbol.
            // `END` means "exit this compound mode" — the wrapper injects
            // the final substate and routes through it.
            target: END,
            // `assign` is typed: `context` is AgentContext, `payload` is
            // the mode's declared payload type ({ messages: Message[] }).
            // No casts; no manual extraction of `event.output`.
            assign: ({ context, payload }) => ({
                messages: [...context.messages, ...payload.messages],
            }),
        },
        // No `target` on retry — semantics are fixed (self-loop). Only
        // `assign` and `when` (for multi-branch) are accepted here.
        retry: {},
        abandoned: { target: END },
        // `error` fires when `behavior` throws or its Promise rejects. The
        // wrapper synthesizes this outcome — the user never writes
        // try/catch in `behavior`. `when` and `assign` see `error: unknown`.
        // (`assign` is omitted here because `AgentContext` has no error
        //  field; a real recipe would extend the context or surface the
        //  error via the §S5 "Observability" seam.)
        error: { target: END },
    },
});

// ── PASSIVE form ─────────────────────────────────────────────────────
// A `listening` state inside a compound. No actor, only event handlers.
// The discriminated union enforces that `input` / `behavior` / `routes`
// cannot appear here — they are not part of this variant's type.
export const socraticListening = defineMode<AgentContext, AgentEvents>({
    on: {
        MESSAGE: { target: "evaluating", actions: "appendUserMessage" },
    },
});
```

Routing flexibility — each `routes[outcome]` value accepts either a single entry or a non-empty array of entries. When it is an array (multi-branch routing — e.g. classifier discriminating by `payload.intent`, or error router discriminating by `error instanceof X`):

- Every non-last entry must carry `when: (...) => boolean` — a predicate. For `achieved` / `retry` / `abandoned`, the predicate receives `payload: P`. For `error`, it receives `error: unknown`. The outcome is already known: it is the map key.
- The last entry must omit `when` and acts as the unguarded default. Order matters: first match wins, same semantics as DD-010's guard array.

Both conditions are **type-enforced** by `RouteList<E>` (see §Type contract): an unguarded non-last entry — which at runtime would shadow every entry below it — is a compile error at the call site, not a silent routing bug.

When the value is a single entry (the common case), `when` is unnecessary.

`target` accepts a sibling state name (string) or `END` (symbol exported by the wrapper). `END` is the **only** way to exit a compound mode — no user code ever declares a `{ type: "final" }` substate. `retry` entries do not carry `target` — retry is always a self-loop on the leaf that produced the outcome. `error` entries additionally accept `target: RE_THROW`, which re-propagates the caught rejection above the actor instead of transitioning. See §Target resolution for the full rule (sibling-name only; no dotted, absolute, or descendant paths).

`error` replaces the separate `onError` field that XState v5 exposes on `invoke`. The wrapper catches any rejection from `behavior` and synthesizes a `{ outcome: "error", error }` event that flows through `routes.error`. The user keeps `behavior`'s return type as `Promise<ModeOutput<TPayload>>` — there is no `Result<>` wrapping at the call site; throwing remains the normal failure escape.

`routes.error` is **optional**. When omitted, the wrapper re-throws the rejection above the actor (the actor crashes). This is the only safe default — silently swallowing a failure that the author did not consciously route would re-create the "quiet failure" problem that pushed errors into the routing layer in the first place. Authors who want graceful error handling declare `routes.error` explicitly, and use `target: RE_THROW` in a multi-branch entry to filter out programmer errors (e.g. `when: (e) => e instanceof TypeError`, `target: RE_THROW`) — keeping the routing in the routes layer instead of hacking `throw` into `assign`.

### `defineAgent` — the machine

```ts
export const zoeMachine = defineAgent({
    id: "agent",
    initial: "listening",
    context: { messages: [] as Message[] },
    events: {} as { type: "MESSAGE"; text: string },

    // Structural actions per DD-004 — reusable plumbing referenced from
    // passive `Mode.on[event].actions` by name. Each value is a pure
    // callback returning a `Partial<TContext>`; the wrapper envelopes it
    // in XState's `assign(...)` at compile time, so user code never
    // imports anything from `xstate`.
    actions: {
        appendUserMessage: ({ context, event }) => ({
            messages: [...context.messages, { role: "user", content: event.text }],
        }),
    },

    modes: {
        listening: rootListening,   // defineMode (passive)
        classifying,                // defineMode (active)
        greetings,                  // defineCompoundMode
        socratic,
        improvising,
    },
});
```

`defineAgent.modes` accepts only `Mode` and `CompoundMode` — same constraint as `defineCompoundMode.modes`. The root `listening` is a passive `defineMode`; there is no place in the wrapper where raw XState state config is accepted. `defineAgent` returns a standard XState `AnyStateMachine` (the value `xstate.createMachine` returns), so anything that consumes an XState machine today — `createActor`, the inspector API, tests — keeps working unchanged. `createAgentActor` (today in `src/machine.ts`; under `examples/zoe/src/` after the restructure) does not change.

### Target resolution

The rule for every `target` field — in `Mode.routes`, in passive `Mode.on[event]`, and in compound `CompoundMode.onDone` — is the same:

- **Sibling name only.** `target` is a single string that names a key in the **immediate enclosing** `modes` map (the compound's, or the agent's). No dotted paths (`"socratic.teaching"`), no XState absolute paths (`"#agent.foo"`), no descendant paths (`".substate"`).
- **Vertical movement only via `END`.** To leave a compound, route to `END`; the parent's `onDone` fires next. There is no "exit two levels at once" shortcut — each level handles its own exit. Nested compounds chain `END` → `onDone: END` to bubble up further.
- **Lateral movement to a compound sibling enters it at its own `initial`.** `target: "socratic"` from a sibling of `socratic` activates `socratic` and starts at whichever substate `socratic` declares as `initial`. The caller does not pick the substate — that is `socratic`'s concern.

**Why so restrictive.** This rule is what makes the rest of the wrapper coherent:

- **Compound-local context (§`defineCompoundMode` "Lexical scoping") only holds** if no external state can reach into a compound's interior. If `target: "socratic.evaluating"` were allowed from outside `socratic`, the caller would have to know `socratic`'s substates, breaking encapsulation; worse, the leaf inside `socratic.evaluating` could be entered with `socratic.local` either initialized or uninitialized depending on the entry path, and the `attempts: 0` reset-on-entry invariant would no longer hold.
- **Initial-state ownership.** A compound owns its `initial`. Allowing callers to override it via dotted paths leaks that ownership into every caller's source.
- **Surface area.** One concept (sibling name) instead of three (sibling, descendant, absolute). Smaller blast radius, smaller doc.

**Type-level vs runtime check.** Today the type is `string` because a `Mode` does not know its enclosing `modes` at definition time (it is defined in one file and slotted into a compound elsewhere). The wrapper's compile step (`compile.ts`) walks the tree, collects every `target` string, and validates it against the actual sibling set at the slot. Unknown targets throw a structured error on machine creation — the error names the offending leaf path, the outcome key, and the bad target. A future spec may tighten this to a type-level check via a placement-time builder, but the cost-benefit is unfavorable today: the runtime error fires the first time `defineAgent` is called (effectively module load), which is one test run away from a compile error in practice.

### Type contract

```ts
// Re-exported from the wrapper. Three outcomes are *intentional* — they are
// produced by `behavior`'s return. The fourth (`error`) is *synthesized* by
// the wrapper when `behavior` rejects; the user never returns it manually
// and `ModeOutput.outcome` does NOT include it.
export type Outcome = "achieved" | "retry" | "abandoned";

export type ModeOutput<TPayload = unknown> = {
    outcome: Outcome;
    payload: TPayload;
};

// Exit token — the only way for a route to leave a compound mode.
// Implemented as a unique symbol so it cannot collide with state names.
export const END: unique symbol;
export type END = typeof END;

// Error-only target — re-throw the caught rejection above the actor
// instead of transitioning. Lets `routes.error` filter out programmer
// errors (TypeError, etc.) without putting `throw` inside `assign`.
// Valid ONLY on `ErrorEntry.target` — `ExitEntry.target` does not accept
// this symbol at the type level.
export const RE_THROW: unique symbol;
export type RE_THROW = typeof RE_THROW;

// Targets for `achieved` / `abandoned` entries (no re-throw — those
// outcomes come from `behavior`'s return, not a rejection).
//
// `string` here means a **single sibling mode name** — a key in the
// enclosing compound's (or agent's) `modes` map. Dotted paths
// (`"socratic.teaching"`), XState absolute paths (`"#agent.foo"`), and
// any other reach-through-the-tree syntax are NOT accepted. Lateral
// movement only to a sibling; vertical movement only via `END`. The
// type stays `string` here because the leaf doesn't know its enclosing
// modes at definition time — the wrapper's compile step validates each
// `target` against the actual sibling set and throws on machine creation
// if the name does not resolve. See §"Target resolution" for the rule
// and rationale.
type RouteTarget = string | END;

// Targets for `error` entries — adds RE_THROW.
type ErrorRouteTarget = string | END | RE_THROW;

// `achieved` and `abandoned` entries — carry a target.
type ExitEntry<C, P> = {
    when?: (payload: P) => boolean;
    target: RouteTarget;
    assign?: (args: { context: C; payload: P }) => Partial<C>;
};

// `retry` entries — no target (retry is always a self-loop on the leaf).
type RetryEntry<C, P> = {
    when?: (payload: P) => boolean;
    assign?: (args: { context: C; payload: P }) => Partial<C>;
};

// `error` entries — fired when `behavior` throws / its Promise rejects.
// The wrapper catches the rejection, synthesizes the outcome, and routes
// through these entries. `when` and `assign` receive the raw error.
// `target: RE_THROW` re-propagates the error instead of transitioning —
// `assign` is ignored on RE_THROW entries (re-throwing is the side effect).
type ErrorEntry<C> = {
    when?: (error: unknown) => boolean;
    target: ErrorRouteTarget;
    assign?: (args: { context: C; error: unknown }) => Partial<C>;
};

// `achieved`, `retry`, and `abandoned` are MANDATORY. `error` is OPTIONAL:
// when omitted, the wrapper re-throws the rejection above the actor (the
// actor crashes loudly). This is the only safe default — omitting `error`
// must not silently swallow a failure. Authors who want graceful handling
// MUST declare `routes.error`.

// Array form — encodes "first match wins, last entry is the default" at
// the **type** level. Non-last entries are required to carry `when`; the
// last entry must omit it. This makes the misplacement of `when` (an
// unguarded entry shadowing later entries — dead code at runtime) a
// compile error rather than a silent routing bug.
//
// `WithWhen<E>` promotes the entry's optional `when` to required.
// `NoWhen<E>` strips `when` from the entry's type (the default's `when`
// must not be present, even as `undefined`).
type WithWhen<E> = E extends { when?: infer W }
    ? Omit<E, "when"> & { when: NonNullable<W> }
    : E;
type NoWhen<E> = Omit<E, "when">;

// An ordered list. Single-entry array: just the default. Multi-entry: one
// or more guarded entries followed by the default. `[]` is unrepresentable
// — the type system rejects it for `achieved` / `abandoned` / `error`;
// `retry` permits `readonly []` separately as the "no special handling"
// shorthand (the wrapper inserts the fixed self-loop regardless).
type RouteList<E> =
    | readonly [NoWhen<E>]
    | readonly [WithWhen<E>, ...readonly WithWhen<E>[], NoWhen<E>];

type Routes<C, P> = {
    achieved:  ExitEntry<C, P>  | RouteList<ExitEntry<C, P>>;
    retry:     RetryEntry<C, P> | readonly [] | RouteList<RetryEntry<C, P>>;
    abandoned: ExitEntry<C, P>  | RouteList<ExitEntry<C, P>>;
    error?:    ErrorEntry<C>    | RouteList<ErrorEntry<C>>;   // optional
};

// Discriminated union — the two variants are mutually exclusive at the type
// level. Trying to use `behavior` and `on` in the same config is a compile
// error. There is no separate `onError` — that is `routes.error`.
export type ActiveModeConfig<C, E extends { type: string }, P> = {
    input: (args: { context: C }) => unknown;
    behavior: (args: { input: unknown }) => Promise<ModeOutput<P>>;
    routes: Routes<C, P>;
};

// One transition. `target` accepts a sibling name or `END` (passive modes
// CAN exit a compound on a particular event); `actions` is a name (or list
// of names) referencing entries declared in `defineAgent.actions`. Inline
// callbacks are NOT accepted here — that would re-introduce DD-004 churn.
// `guard` is optional; when present, the transition only fires if it
// returns true. For array form, first match wins (XState semantics).
type EventTransition<C, E_> = {
    target?: RouteTarget;
    actions?: string | readonly string[];
    guard?: (args: { context: C; event: E_ }) => boolean;
};

// Map from event discriminant (`event.type`) to one transition or an
// ordered list of transitions. The transition's `event` callback argument
// is narrowed to the matching event variant via `Extract<E, { type: K }>`.
type EventHandlers<C, E extends { type: string }> = {
    [K in E["type"]]?:
        | EventTransition<C, Extract<E, { type: K }>>
        | readonly EventTransition<C, Extract<E, { type: K }>>[];
};

export type PassiveModeConfig<C, E extends { type: string }> = {
    on: EventHandlers<C, E>;
};

export type ModeConfig<C, E extends { type: string }, P> =
    | ActiveModeConfig<C, E, P>
    | PassiveModeConfig<C, E>;

// Opaque types — internal shape is implementation detail of the wrapper.
export type Mode<TContext, TEvents extends { type: string }, TPayload = unknown> = { /* opaque */ };
export type CompoundMode<TContext, TEvents extends { type: string }> = { /* opaque */ };

// A mode slot in a compound or agent — either a leaf mode (active or
// passive) or a nested compound. Raw XState configs are NOT accepted —
// this is the only way to populate `modes`.
type ModesMap<TContext, TEvents extends { type: string }> = Readonly<Record<
    string,
    Mode<TContext, TEvents> | CompoundMode<TContext, TEvents>
>>;

// Compound-local context. `inherit` lists keys from the enclosing context
// that are live-mirrored into this compound; `local` declares own variables
// initialized on entry and reset on re-entry. Children (leaves and nested
// compounds) see `Pick<TParent, inherit[number]> & typeof local` as their
// context — keys not in `inherit` are invisible at the type level.
//
// `TInherit` must be a `readonly` tuple of string keys of `TParent` so the
// element type is preserved literally (e.g. `["messages"] as const`).
type CompoundContext<
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
type LocalContextOf<TParent, TCtx> =
    TCtx extends CompoundContext<TParent, infer I, infer L>
        ? Pick<TParent, I[number]> & L
        : TParent;

// `initial` is typed as `keyof TModes` so a typo here is a compile error.
// `onDone` is the parent transition target fired when any child routes to
// `END` (the wrapper injects the final substate). It accepts a sibling
// name OR `END` (when the compound itself is nested inside another).
//
// `context` is OPTIONAL. When present, children of this compound see only
// `Pick<TParentContext, inherit[number]> & typeof local`; when omitted, they
// see the full `TParentContext`. See §`defineCompoundMode` "Lexical scoping" for
// semantics.
export type CompoundModeConfig<
    TParentContext,
    TEvents extends { type: string },
    TCtx extends
        | CompoundContext<TParentContext, ReadonlyArray<keyof TParentContext & string>, object>
        | undefined,
    TModes extends ModesMap<LocalContextOf<TParentContext, TCtx>, TEvents>
> = {
    context?: TCtx;
    initial: keyof TModes & string;
    modes: TModes;
    onDone: RouteTarget;
};

// `events` is a phantom field — only its type matters. The example
// passes `{} as TEvents`, which is the idiomatic shape and matches how
// XState surfaces the event type today.
//
// `actions` registers reusable, pure callbacks referenced by name from
// passive `on[event].actions`. Each callback returns `Partial<TContext>`;
// the wrapper applies `assign(...)` at compile time so user code never
// imports from `xstate`. The callback's `event` is typed as the full
// `TEvents` union — narrowing is the action body's responsibility.
export type AgentConfig<
    TContext,
    TEvents extends { type: string },
    TModes extends ModesMap<TContext, TEvents>
> = {
    id: string;
    initial: keyof TModes & string;
    context: TContext;
    events: TEvents;
    actions?: Readonly<Record<
        string,
        (args: { context: TContext; event: TEvents }) => Partial<TContext>
    >>;
    modes: TModes;
};

export function defineMode<TContext, TEvents extends { type: string }, TPayload = unknown>(
    config: ModeConfig<TContext, TEvents, TPayload>,
): Mode<TContext, TEvents, TPayload>;

// `TParentContext` is the context the slot enclosing this compound exposes —
// either the agent's root context (when this compound is mounted directly
// under `defineAgent.modes`) or the enclosing compound's local context
// (when nested). The return type is `CompoundMode<TParentContext, TEvents>` so the
// compound fits the slot its siblings occupy; the internal narrowing produced
// by `context` is encapsulated and not visible to the parent.
export function defineCompoundMode<
    TParentContext,
    TEvents extends { type: string },
    TCtx extends
        | CompoundContext<TParentContext, ReadonlyArray<keyof TParentContext & string>, object>
        | undefined,
    TModes extends ModesMap<LocalContextOf<TParentContext, TCtx>, TEvents>
>(
    config: CompoundModeConfig<TParentContext, TEvents, TCtx, TModes>,
): CompoundMode<TParentContext, TEvents>;

export function defineAgent<
    TContext,
    TEvents extends { type: string },
    TModes extends ModesMap<TContext, TEvents>
>(
    config: AgentConfig<TContext, TEvents, TModes>,
): AnyStateMachine;   // from xstate
```

The wrapper's job is to make `assign` and `when` callbacks see the actor's payload type without manual casts (addresses P4), to make the active/passive distinction compiler-enforced rather than convention, and to make outcome handling exhaustive (the type system requires all three keys; a missing one is a compile error).

### Actions: named in passive, inline in routes (intentional asymmetry)

The two call sites accept different shapes:

- **`defineAgent.actions[name]`** holds reusable, pure callbacks `({ context, event }) => Partial<TContext>`. Their `event` argument is typed as the full `TEvents` union — narrowing on `event.type` is the callback body's job.
- **Passive `on[event].actions`** references those names — `string` or `readonly string[]`. Inline callbacks are not accepted here. Rationale: passive transitions are the DD-004 reuse site (e.g. `appendUserMessage` fires from multiple `on:` blocks). Forcing them to be named also forces them to be declared once at the agent level, which is exactly the discipline DD-004 codifies.
- **`routes[outcome][i].assign`** is the inverse: inline callbacks only, no naming. Rationale: a route's `assign` closes over the mode's **typed payload** (`P`), which differs per mode. Naming it would force `defineAgent.actions` to be generic over payload — a lot of type machinery for callbacks that are nearly always one-off, and would re-open the door to the untyped `event.output` access that P4 was written to close. Users who want to share a route `assign` across modes can extract the callback into a regular const and reference it inline — no escape hatch in the type system required.

The asymmetry is therefore not an oversight: each call site enforces the right shape for its role.

## Common Patterns

Recipes built from the primitives above. None of these are wrapper features — they are conventions users follow until a future spec automates them via the extension seams.

### Retry budget — bound the number of retries before abandoning

**Problem:** A mode whose `behavior` may return `retry` will self-loop forever if the underlying condition does not change. The wrapper does not bound retries — the mode must decide when to stop and return `abandoned` instead.

> **Forward-looking note.** The canonical site for this recipe is `socratic.evaluating`, which is **not** migrated by this spec (see §Migration steps step 4 — the entire `socratic` compound is deferred to a follow-up on top of spec 003). The recipe below shows the shape the migrated `socratic.evaluating` will take once that follow-up lands; until then, `socratic` stays in raw XState and uses spec 003's existing sideways-jump retry. The recipe is included here because the wrapper feature it exercises — compound-local context — is in scope for this spec.

**Pattern:** Keep an attempt counter in the enclosing compound's **local** context (see §`defineCompoundMode` "Lexical scoping"). `routes.retry.assign` increments it. `behavior` checks it before paying for the LLM call and forces `abandoned` once the budget is spent. Reset is **automatic** — the local slot is cleared on every fresh entry to the compound — so the user does not write reset logic in `achieved` / `abandoned` / `error`.

```ts
// 1. The counter lives in the enclosing compound's local context. It is
//    invisible to the agent's root context and to sibling compounds.
const socratic = defineCompoundMode({
    context: {
        inherit: ["messages"] as const,
        local: { attempts: 0 },
    },
    initial: "teaching",
    modes: { teaching: socraticTeaching, listening: socraticListening, evaluating: socraticEvaluating },
    onDone: "classifying",
});

// 2. The leaf sees context typed as `Pick<AgentContext, "messages"> & { attempts: number }`
//    — the slice declared by `socratic.context.inherit` plus its `local`. It reads
//    `attempts` via `input` and increments it via `routes.retry.assign`. No reset
//    needed — exiting the `socratic` compound (via `END` → `onDone`) clears the
//    local slot, so the next time the user routes back into socratic the counter
//    starts at 0 again.
const socraticEvaluating = defineMode<
    Pick<AgentContext, "messages"> & { attempts: number },
    AgentEvents,
    undefined
>({
    input: ({ context }) => ({
        messages: context.messages,
        attempts: context.attempts,
    }),

    behavior: async ({ input }) => {
        // Budget spent — force abandoned before paying for another LLM call.
        if (input.attempts >= 3) {
            return { outcome: "abandoned", payload: undefined };
        }
        const result = await chat(input.messages, EVALUATION_PROMPT);
        return parseEvaluation(result);   // achieved | retry | abandoned
    },

    routes: {
        achieved:  { target: END },
        retry:     { assign: ({ context }) => ({ attempts: context.attempts + 1 }) },
        abandoned: { target: END },
        // Network failure during evaluation: just exit. `assign` is for state
        // mutation only; the §S5 "Observability" seam handles surface logging
        // of the error itself. No reset assign needed — compound exit handles it.
        error:     { target: END },
    },
});
```

**Why the budget decision lives in `behavior`:** `routes` only routes the outcome the `behavior` produced. There is no `routes.retry.guard` that converts retry → abandoned at the routing layer (and adding one would split the abandonment decision across two places). The `behavior` is the single point of decision; `routes` is plumbing.

**Why no reset on achieved/abandoned/error:** the counter lives in the `socratic` compound's local context, not the agent root. The wrapper's exit action clears the local slot when the compound's `onDone` fires (or when it is otherwise exited), so re-entering socratic starts the counter at `0` automatically. Reset is structural, not a routing concern.

**Remaining limitations (and the path forward):**
- The budget value (`3`) is hardcoded in the `behavior` rather than declared next to the mode.
- The increment/check pair (`if (input.attempts >= 3)` in `behavior`, `attempts: context.attempts + 1` in `routes.retry`) is still spread across two call sites within the leaf.

Extension seam **S3** (composable mode policies) is designed to absorb this pattern into a wrapper-provided helper:

```ts
// Future — not in this spec.
const socraticEvaluating = withRetryBudget(
    defineMode({ /* ... no manual counter ... */ }),
    { max: 3 },
);
```

`withRetryBudget` will own the counter (mode-local state, invisible to the agent context), the reset, and the conversion of `retry → abandoned` at budget exhaustion. Until that spec lands, the manual pattern above is the supported approach.

## Mapping: Wrapper → XState

The wrapper is **pure compile-time sugar** — at runtime there is no extra layer. `defineAgent` walks the state tree, lifts every active `Mode`'s actor into `setup().actors`, derives the actor name from the state path (DD-008's naming convention is now an invariant enforced by the compiler), and expands `routes` into `onDone` guard arrays. Concretely:

| Wrapper concept                                  | XState equivalent generated by the wrapper                              |
| ------------------------------------------------ | ----------------------------------------------------------------------- |
| Active `Mode` mounted at path `p`                | `invoke.src = "<camelCase(p)>Node"`; actor registered in `setup().actors` |
| Passive `Mode` mounted at path `p`               | `{ on: ... }` — atomic state with only event handlers; no actor         |
| `Mode.input`                                 | `invoke.input`                                                          |
| `Mode.behavior`                              | `fromPromise(async ({ input }) => ...)`                                 |
| `Mode.routes` (the whole map)                | `onDone: [...]` — one ordered entry per `routes[outcome][i]`            |
| `routes.achieved` / `routes.abandoned` entry     | `onDone[i].guard = e => e.output.outcome === "<key>" && when?(e.output.payload)`; `target` rewritten |
| `routes.retry` entry                             | `onDone[i].guard = e => e.output.outcome === "retry" && when?(e.output.payload)`; `target` is the leaf's own path (self-loop) |
| Array form `routes[outcome] = [..., {default}]`  | Each element becomes one `onDone` entry, in order — first match wins. The final entry (no `when`) is the unguarded default for that outcome. |
| `routes[outcome][i].target = "siblingName"`      | `onDone[i].target = "siblingName"` (resolved as XState sibling — relative key in the immediate enclosing `states`). Dotted / absolute paths are rejected by the wrapper's compile step before XState sees them. |
| `routes[outcome][i].target = END`                | `onDone[i].target = "<injected-final-name>"` (see below)                |
| `routes[outcome][i].assign`                      | `onDone[i].actions = assign(({ context, event }) => f({ context, payload: event.output.payload }))` (typed) |
| `routes.error` entry                             | `invoke.onError[i]` — the wrapper catches the rejection, exposes the raw `error` to `when` / `assign`, then emits `onError[i].target` + optional `assign(...)`. The user never writes `invoke.onError` directly. **When `target` is `RE_THROW`**, the generated `onError[i]` action re-throws the captured rejection instead of firing an XState transition; `assign` on that entry is ignored (re-throwing is the side effect), and the rejection then propagates above the actor exactly as if `routes.error` had omitted that entry. |
| `defineAgent.actions[name]` (pure callback)      | `setup({ actions: { [name]: assign(({ context, event }) => ...) } })` — wrapper applies `assign(...)` so user code never imports from `xstate` |
| `CompoundMode`                                   | A compound XState state node (`{ initial, states, onDone }`) with an injected final substate |
| `CompoundMode.context` (`{ inherit, local }`)            | Wrapper allocates a local slot under a generated context key (e.g. `__<compoundPath>_local`) initialized to `local`'s declared shape via an `entry` action; an `exit` action clears it. Children's `input` / `assign` callbacks are rewritten at compile time: reads of `inherit` keys go to the agent's root context (live), reads of `local` keys go to the local slot; writes to `inherit` keys update the root context, writes to `local` keys update the local slot. Reading a non-inherited parent key inside a child is a compile error before any rewriting. |
| `defineAgent`                                    | `setup({ types, actions, actors }).createMachine({ ... })`              |

The generated `setup({ actors })` map is the union of every active `Mode` discovered in the tree. The user never writes it.

### `END` and the injected final substate

For every `CompoundMode` whose children use `target: END` anywhere in their `routes` (or `onError`), the wrapper injects a final substate (name: implementation detail — e.g. `$end` — chosen so it cannot collide with user-declared state names) into the compound's `states`. Every `END` target is rewritten to that name at compile time. The compound's `onDone` (the parent transition declared by the user) fires when the final substate is entered, exactly as a hand-written `{ type: "final" }` would have done.

If a compound's children never target `END`, no final substate is injected — the compound stays "open" and only exits via explicit sibling targets. This matches the behavior of compounds today.

### Worked example: `classifying` before/after

This mode is a good showcase because it exercises **multi-branch routing on the payload** (the classifier dispatches by `payload.intent`) — the case that demands the array form with `when` predicates.

**Before** (`src/machine.ts:51-75` plus `src/states/classifying.mode.ts`):

```ts
// machine.ts
classifying: {
    invoke: {
        src: "classifyingMode",
        input: ({ context }) => ({ messages: context.messages }),
        onDone: [
            { guard: ({ event }) => event.output.payload.intent === "greetings",   target: "greetings" },
            { guard: ({ event }) => event.output.payload.intent === "socratic",    target: "socratic" },
            { guard: ({ event }) => event.output.payload.intent === "none",        target: "listening" },
            { target: "improvising" },
        ],
    },
},

// classifying.mode.ts
export const classifyingMode = fromPromise(
    async ({ input }: { input: { messages: Message[] } }): Promise<ModeOutput<{ intent: Intent }>> => { ... }
);

// machine.ts setup() block
actors: { ..., classifyingMode },
```

Notice the costs P1–P4 in one place: the actor is registered in `setup().actors` separately from the state that invokes it (P1); every `onDone` entry repeats the same `event.output.payload.intent === ...` shape (P2); `event.output` is `unknown` until cast (P4); and the prompt / actor / state triplet is held together only by the file's naming convention (P3).

**After:**

```ts
// examples/zoe/src/states/classifying.ts
import { defineMode } from "atlas";

type ClassifierPayload = { intent: "greetings" | "socratic" | "none" | "improvising" };

export const classifying = defineMode<AgentContext, AgentEvents, ClassifierPayload>({
    input: ({ context }) => ({ messages: context.messages }),
    behavior: async ({ input }) => {
        // identical body; return type is ModeOutput<ClassifierPayload>
    },
    routes: {
        // `payload` is typed as ClassifierPayload at every `when` and `assign`
        // call site. No `event.output` access; no casts.
        achieved: [
            { when: (payload) => payload.intent === "greetings", target: "greetings" },
            { when: (payload) => payload.intent === "socratic",  target: "socratic" },
            { when: (payload) => payload.intent === "none",      target: "listening" },
            { target: "improvising" },   // default; no `when`
        ],
        // The classifier never returns retry or abandoned, but the type
        // system requires both keys. `abandoned` picks a safe target —
        // "listening" — instead of self-looping on the same messages.
        // `retry: {}` compiles to the fixed self-loop; safe here because
        // the classifier's `behavior` never returns retry.
        retry:     {},                       // RetryEntry; no target — fixed self-loop
        abandoned: { target: "listening" },  // ExitEntry; target is mandatory
    },
});
```

The actor name (`classifyingNode`) is derived from the state path `classifying` and registered automatically. `event.output` is gone from user code — `when` receives `payload` directly, typed as `ClassifierPayload`. The `setup({ actors })` map is generated.

## Extension Seams (designed-in, not implemented in this spec)

Each seam lists the **place in the API** where the future feature plugs in and the **invariant** the wrapper preserves so the seam stays viable.

### S1 — Per-mode LLM configuration

`defineMode` will accept an optional `llm: { model, temperature, ... }` field whose value is passed as the second argument to `behavior`. The seam: **`behavior` already receives a context object (`{ input, ... }`), not just `input`**. Adding `llm`, `signal` (for cancellation), `logger`, etc. to that object is non-breaking.

### S2 — Middleware / lifecycle hooks

Future fields: `onEnter`, `onExit`, `beforeBehavior`, `afterBehavior`. The seam: **`defineMode`'s config is an open object literal** and the wrapper's compile step is centralized in one function. Adding hooks is a matter of wrapping `behavior` in a higher-order function at compile time and inserting `entry`/`exit` actions on the generated state.

### S3 — Composable mode policies

Functions like `withRetryBudget(mode, { max: 3 })`, `withTimeout(mode, 30_000)`. The seam: **`Mode` is an opaque type with a documented compile-time shape; the wrapper exports a `compileMode` helper internally** so policy functions can wrap an existing mode and re-emit a new one. Policies are higher-order modes, not configuration flags.

### S4 — Streaming responses

`behavior` returns `Promise<ModeOutput<T>>` in this spec — the contract is strict and **not** pre-widened. A future streaming spec will need to widen the return type to a union (e.g. `Promise<ModeOutput<T>> | AsyncIterable<Chunk<T> | ModeOutput<T>>`), but the shape of `Chunk<T>` and how routes observe partial output are deliberately undesigned here. Pre-reserving syntax without semantics would lock in a bad shape; option-value comes from the rest of the contract being forward-compatible, not from the union existing today.

What protects forward-compatibility: streaming chunks are **out-of-band side effects**, not new outcomes. `Routes` does not move — the four outcomes (`achieved` / `retry` / `abandoned` / `error`) still describe how the mode terminates, regardless of whether chunks were emitted along the way. The widening is therefore well-isolated to `behavior`'s return type and the wrapper-internal code that consumes it; `defineMode` callers who don't opt into streaming see no API change. That isolation is the seam.

### S5 — Observability

Every actor name is derivable from the state path (DD-008 as invariant). The wrapper exposes this mapping (`getActorPath(actor)` or similar) so an inspector can label transitions with the human-readable mode path. The existing `createAgentActor` inspector loop (today in `src/machine.ts`, under `examples/zoe/src/` after the restructure) keeps working; new features get richer data without breaking it.

## Monorepo Restructure

The project becomes a workspace with one library (`packages/atlas/`) and one reference consumer (`examples/zoe/`). The library is the deliverable of this spec; `zoe` is the worked example that demonstrates the API and exercises every code path the wrapper supports. Additional examples may be added under `examples/` later without further restructure.

### Target layout

```
/                                         (workspace root)
├── package.json                           workspaces: ["packages/*", "examples/*"]
├── tsconfig.base.json                     shared compiler options
├── packages/
│   └── atlas/
│       ├── package.json                   name: "atlas"
│       ├── tsconfig.json
│       ├── src/
│       │   ├── index.ts                   barrel
│       │   ├── defineMode.ts
│       │   ├── defineCompoundMode.ts
│       │   ├── defineAgent.ts
│       │   ├── compile.ts                 internal: wrapper → XState
│       │   └── types.ts                   ModeOutput, Mode<>, CompoundMode<>
│       └── test/
│           ├── defineMode.test.ts        runtime
│           ├── routing.test.ts               runtime
│           ├── compile.test.ts               runtime
│           └── types/                        type-only (.test-d.ts) — Vitest --typecheck
│               ├── routes.test-d.ts
│               ├── context.test-d.ts
│               └── ...
└── examples/
    └── zoe/                               current project moves here (renamed from "Atlas")
        ├── package.json                   name: "zoe", depends on "atlas"
        ├── tsconfig.json
        ├── src/                           current src/
        ├── test/                          current test/
        ├── scripts/                       current scripts/
        └── .env.example
```

`docs/` and `README.md` stay at the repo root. Rationale: the design decisions and architecture diagrams describe `zoe` as the reference example for the wrapper; they belong to the workspace as a whole, not to a single example. Moving them under `examples/zoe/` would require updating the mermaid sync script paths for no readability gain.

### Migration steps

1. **Add workspaces.** Add `workspaces: ["packages/*", "examples/*"]` to root `package.json`. Move all current Atlas application files into `examples/zoe/` and update internal references to the new agent name (`zoe`). Update `scripts.start` to `tsx examples/zoe/src/index.ts` (or use `npm -w zoe start`). The agent's user-facing system prompts ("Voce e Atlas...") are updated to "Voce e Zoe...".
2. **Create the package skeleton.** `packages/atlas/package.json` with `"type": "module"`, peer dep on `xstate ^5`, no runtime deps. `tsconfig.json` extending the shared base.
3. **Implement the wrapper.** `compile.ts` walks the state tree, generates actor names, lifts actors into `setup().actors`, expands routes into `onDone`. `defineMode` / `defineCompoundMode` / `defineAgent` are thin constructors that hand config to `compile.ts`.
4. **Migrate Zoe.** Rewrite `examples/zoe/src/machine.ts` and every mode that maps cleanly onto the wrapper today: root `listening`, `classifying`, `greetings.thinking`, `improvising.thinking` — three mode files plus the root passive `listening` (today inline in `machine.ts`). The **entire `socratic` compound is deferred** to a follow-up spec on top of 003. Reason: `socratic.evaluating`'s `retry` semantic in spec 003 is a sideways jump back to `teaching`, which does not map onto the wrapper's self-loop retry. Two paths forward, both behavior changes: (a) restructure the substate graph so the bounce becomes a normal `achieved` + sibling-target transition; or (b) adopt the wrapper's self-loop retry with a counter — the recipe in §Common Patterns "Retry budget", which uses compound-local context. Migrating only `socratic.teaching` and `socratic.listening` would force the socratic compound to mix wrapped and unwrapped substates — the wrapper rejects raw XState nodes inside `defineCompoundMode.modes`, and adding an escape hatch only to bridge this one mode would re-open the door the wrapper exists to close. Until the follow-up lands, `socratic` stays as-is in XState; the migration still earns its place because the four other modes drop the actor-registration / output-cast / done-substate boilerplate.
5. **Verify.** Per §Verification below.

The migration is a single PR — splitting it would leave Zoe in a half-wrapped state. The wrapper has no consumers other than Zoe, so backward compatibility is not a concern.

## File Map

| File | Change |
| --- | --- |
| `docs/specs/004-xstate-agent-wrapper.md` | New spec (this document) |
| `docs/specs/README.md` | Add 004 to index |
| `docs/design-decisions.md` | Add DD-012 (or higher) recording the wrapper decision and how it relates to DD-008, DD-009, DD-010, DD-011 |
| `package.json` (root) | Add `workspaces`. Update scripts to delegate to workspaces |
| `tsconfig.json` (root) → `tsconfig.base.json` | Become a shared base; per-package `tsconfig.json` extends it |
| `packages/atlas/package.json` | New |
| `packages/atlas/tsconfig.json` | New |
| `packages/atlas/src/index.ts` | New — barrel export |
| `packages/atlas/src/defineMode.ts` | New |
| `packages/atlas/src/defineCompoundMode.ts` | New |
| `packages/atlas/src/defineAgent.ts` | New |
| `packages/atlas/src/compile.ts` | New — internal compiler from wrapper config to XState `setup().createMachine()` |
| `packages/atlas/src/types.ts` | New — re-exports `ModeOutput`; declares `Mode`, `CompoundMode`, config types |
| `packages/atlas/test/*` | New — unit tests for compilation, routing, error paths |
| `examples/zoe/*` | All current Atlas application files moved from project root and renamed to Zoe |
| `examples/zoe/src/machine.ts` | Rewritten to use `defineAgent` / `defineCompoundMode` |
| `examples/zoe/src/states/*.ts` | Migrated mode files (those not deferred — see §Migration steps step 4) lose the `.mode.ts` suffix and are rewritten to use `defineMode` instead of `fromPromise` + inline `onDone`; system prompts updated from "Atlas" to "Zoe". Deferred files (`socratic.*.mode.ts`) keep their original suffix and content until the spec-003 follow-up. |
| `examples/zoe/src/types.ts` | Imports `ModeOutput` from `atlas` instead of declaring it locally |
| `scripts/sync-mermaid.mjs` | Update file paths to follow the move under `examples/zoe/` |
| `.githooks/*` | Update file paths if needed |

## Verification

1. **Existing test suite.** `npm test` (which runs vitest across the workspace) passes. `examples/zoe/test/machine.test.ts` is unchanged in intent: same scenarios, same outputs. If a test needs to change to import from the new path, that is mechanical; the assertions stay.
2. **Manual smoke test, all paths in spec 003 §Verification.** Each of the 8 scenarios listed there reproduces identically after the migration: first-message greeting, greeting with follow-up, socratic happy path, socratic retry, socratic abandonment, general question via improvising, alternating-turns invariant after retry.
3. **Wrapper unit tests.**

   *Type-only tests* (everything below tagged "type-only test" or "compile error") use **Vitest's built-in typecheck mode** (`vitest --typecheck`). Positive assertions use `expectTypeOf<T>()` from `vitest`; cases that must fail to compile use `// @ts-expect-error` directives — if the next line **does** compile, Vitest fails the test. No additional library is added: Vitest is already in the workspace, supports both idioms natively, and runs the typecheck pass via `tsc` under the hood. Type-test files live under `packages/atlas/test/types/` with the `.test-d.ts` suffix; the runtime suite stays in `*.test.ts`. CI runs the runtime suite and the typecheck pass separately — either failing fails the build.

   *Runtime tests* below use Vitest as today.

   - An active `Mode` with single-entry routes on every outcome compiles to (a) a XState `onDone` array of exactly three entries — `achieved` / `retry` / `abandoned` — each guarded on `event.output.outcome === "<key>"`, and (b) a separate `invoke.onError` entry for `routes.error`. Snapshot the generated `setup({ actors })` keys, `onDone` shape, and `onError` shape.
   - A passive `Mode` (only `on:` declared) compiles to an atomic state with the same `on` handlers and no `invoke`.
   - The discriminated union refuses `defineMode({ behavior, on })` at compile time, and the active variant refuses a `routes` object missing any of `achieved` / `retry` / `abandoned` (type-only tests assert both errors). `error` is optional — omitting it compiles.
   - When `behavior` rejects and `routes.error` is omitted, the rejection propagates above the actor (assert via a test that the parent receives the rejection — XState's `actor.subscribe` reports the error transition).
   - `routes.achieved`, `routes.abandoned`, and `routes.error` reject the empty array `[]` at the type level via the `RouteList<E>` constraint (type-only test). `routes.retry` accepts `{}`, `readonly []`, **and** the same guarded `RouteList<RetryEntry>` shape; empty / single-default forms fall back to the fixed self-loop.
   - An array-form `routes[outcome]` where a non-last entry omits `when` (would shadow later entries at runtime) is a compile error — `RouteList<E>` requires `WithWhen<E>` in every non-last position (type-only test).
   - An array-form `routes[outcome]` where the last entry carries `when` (no unguarded default) is a compile error — `RouteList<E>` requires `NoWhen<E>` in the tail position (type-only test).
   - When `routes[outcome]` is cast with `as Routes<...>` to bypass the type constraint, the wrapper's compile step (`compileMode`) re-validates the `RouteList<E>` shape and throws a structured error on machine creation. Runtime test asserts the throw and its message names the offending outcome key and index.
   - **Target resolution** (sibling name only):
     - A `target` that names a key in the immediate enclosing `modes` resolves to an XState sibling transition — assert by snapshotting the generated `onDone[i].target` equals the literal sibling name (runtime test).
     - A `target` containing `.` (e.g. `"socratic.teaching"`), starting with `#` (XState absolute path), or starting with `.` (descendant path) is rejected by the wrapper's compile step. Runtime test: constructing an agent with such a target throws on `defineAgent(...)` call; the error message names the offending leaf path, the outcome (or event) key, and the literal bad target string.
     - A `target` that is a valid identifier shape but does not name any actual sibling is also rejected at the compile step with the same error format.
     - `target: "siblingCompound"` (sibling is itself a `CompoundMode`) enters the compound at its declared `initial` — assert by snapshotting the resulting state value after the transition (runtime test).
     - `END` is the only upward escape: a leaf cannot target a state two levels up directly. Verified by attempting to write `target: "<grandparent-sibling>"` and observing the compile step's "not a sibling" rejection.
   - A `Mode` mounted at `socratic.evaluating` registers an actor named `socraticEvaluatingNode` (DD-008 as code).
   - A `routes.retry` entry has no `target` at the type level (compile error if the user supplies one) and compiles to a self-loop on the same leaf — the generated `onDone[i].target` equals the leaf's own state path.
   - A multi-branch `routes.achieved` (array form) where every non-last entry carries `when: (payload) => boolean` produces ordered `onDone` entries whose guards combine `outcome === "achieved"` with the `when` predicate; the last entry has only the outcome check. Verify with a classifier-style payload dispatching on `payload.intent` (the worked example above).
   - A multi-branch `routes.error` whose `when` predicates dispatch on `error instanceof X` produces ordered `onError` entries; a thrown error matching `when` routes to the corresponding `target` (runtime test asserting that a rejected `behavior` walks the entries in order).
   - When `behavior` rejects and the user's `routes.error.assign` is invoked, the `error` value passed equals the rejection reason verbatim — no unwrapping or normalization done by the wrapper.
   - A `routes.error` entry with `target: RE_THROW` whose `when` matches the thrown error re-propagates the rejection above the actor (no XState transition fires; the parent observer receives the error). `assign` on that entry is **not** invoked, and a later entry without `when` (e.g. a catch-all `{ target: "recovering" }`) is **not** evaluated for the same rejection — `RE_THROW` is terminal for the dispatch walk, just like any matched target.
   - A `routes[outcome].target = END` (valid on `achieved` / `abandoned` / `error`) rewrites to the injected final substate name and the surrounding compound's `onDone` fires when reached.
   - A `CompoundMode` whose children never use `END` does **not** emit an injected final substate.
   - A `CompoundMode` declaring `context: { inherit: ["messages"], local: { count: 0 } }` exposes only `messages` and `count` to its children. Accessing a non-inherited parent key inside any child's `input` or `assign` is a compile error (type-only test).
   - Writes to an inherited key from a leaf inside the compound mirror to the parent **synchronously**: assert by reading the agent's context immediately after the leaf's `assign` runs and observing the new value (no entry/exit lift-and-project step).
   - Local keys reset on every entry to the compound: enter, mutate via a leaf, exit via `onDone`, re-enter, and confirm the local key equals its declared initial value (runtime test).
   - A `CompoundMode` nested inside another `CompoundMode` scopes its `inherit` against the **immediate** enclosing compound's local context (not the agent root). Type-only test: declaring `inherit: ["k"]` inside a nested `CompoundMode` whose enclosing compound's local context does not expose `k` is a compile error, even when the agent's root context does expose `k`.
   - Omitting `context` keeps the full enclosing context visible: a `CompoundMode` without `context` has children typed against the same context as the parent (or the agent root). Confirmed by the existing migrated Zoe modes — they remain unchanged when no narrowing is desired.
   - The `when` and `assign` callbacks inside `routes.achieved` / `retry` / `abandoned` see `payload` typed as `TPayload`; the callbacks inside `routes.error` see `error: unknown` (typed by `ErrorEntry<C>`, not `ExitEntry<C, P>`). `context` is always typed as `TContext` (type-only test).
4. **Diff in `examples/zoe/src/machine.ts`.** After migration, `machine.ts` is materially shorter: no actor registrations, no inline `assign({ messages: ... })` duplications, no `event.output` casts, no `done: { type: "final" }` declarations. The diff itself is part of verification — if the file did not shrink, the wrapper did not earn its place.
5. **No XState API leakage in user code.** A migrated Zoe source file imports from `atlas` only. Importing anything from `xstate` directly inside `examples/zoe/src/**` — or seeing a raw `{ type: "final" }`, `fromPromise(...)`, or `assign(...)` call at any user-code call site — is a wrapper bug, not an escape hatch. `defineAgent.actions[name]` receives a plain callback `({ context, event }) => Partial<TContext>`; the `assign(...)` envelope is applied by the wrapper.

## Out of Scope

- Implementing per-mode LLM config, middleware, retry/timeout policies, streaming, or dynamic mode registration. Each gets its own spec.
- Replacing or hiding the XState inspector API. The wrapper compiles to a standard machine and the inspector continues to see real XState events.
- Publishing `atlas` to npm. The package lives in the monorepo as `private: true` for now.
- Renaming `ModeOutput`. The name is stable; only its location moves (from `examples/zoe/src/types.ts` to `packages/atlas/src/types.ts`).
- Touching the LLM client (`llm-client.ts`) or the chat flow contract with OpenRouter.

