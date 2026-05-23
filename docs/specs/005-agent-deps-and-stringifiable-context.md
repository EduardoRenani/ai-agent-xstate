# 005 — Agent Deps & Stringifiable Context

## Status

Done. Implemented in the `feat/agent-state-and-deps` branch (depends on 004 — XState Agent Wrapper). Purely additive: no renames, no field changes. The implementation constrained `TContext` via `JsonCompatible<T>` at field positions, added `TDeps` with shallow `Object.freeze` at construction time, threaded `deps` through every read/write callback envelope (`input`, `behavior`, `routes.*.assign`, `routes.*.guard`, `EventTransition.guard`), and kept `when` deps-free. Design decisions: DD-021 (JSON constraint), DD-022 (construction-time deps freeze), DD-023 (`when` stays deps-free). Verified by 145 runtime tests + 64 type-level tests, all passing.

## Goal

Two coupled additions to the `atlas` wrapper, both extending the public API without renaming anything:

1. **Constrain** `TContext` at the type level to a JSON-serializable shape (`JsonObject`), so any agent context can round-trip through arbitrary storage (file, KV, blob, message broker) without the wrapper or the consumer doing custom encoding.
2. **Add** `AgentDeps` — a typed, immutable dependency container declared on `defineAgent` and threaded through every user callback that mutates or reads context. Provides access to external resources (DB driver, logger, LLM client) without module-global coupling. Optional field with a typed empty default.

After this spec, the wrapper's three constructors carry an extra `TDeps` generic: `<TContext, TEvents, TModes, TDeps>` on `defineAgent`, `<TContext, TEvents, TPayload, TDeps>` on `defineLeafMode`, `<TParentContext, TEvents, TCtx, TModes, TDeps>` on `defineMode`. All existing names — `AgentContext`, `TContext`, `TParentContext`, `CompoundContext`, `LocalContextOf`, the `context` field on `AgentConfig` / `ModeConfig` — are preserved.

## Problems Addressed

### P5 — `TContext` admits non-serializable shapes silently

Spec 004's `TContext` is unconstrained (`AgentConfig<TContext, ...>`). Today's Zoe context happens to be `{ messages: Message[] }` — JSON-safe by accident, not by contract. A future mode can add `lastSeen: Date`, `pendingCalls: Map<string, Promise>`, or a class with methods, and nothing flags it until the agent is persisted and `JSON.stringify` either drops the field (`Map` → `{}`), produces a lossy string (`Date` → ISO string but parses back as string), or throws (cyclic). Storage-backed flows must catch this at the type level, not at the first checkpoint.

### P6 — No injection seam for external resources

Modes that need a DB driver, an LLM client, a logger, or a feature-flag client today import them as module globals. That couples each mode file to a specific runtime instance, makes test isolation require module mocks, and forbids running two agents side-by-side with different backends. The wrapper has no mechanism that says "these resources are inputs to the machine, not context, not events".

## New Types

Exported from `atlas`:

```ts
export type JsonPrimitive = string | number | boolean | null | undefined;
export type JsonValue = JsonPrimitive | JsonValue[] | { [k: string]: JsonValue };
export type JsonObject = { [k: string]: JsonValue };
export type JsonArray = JsonValue[];

// Recursive structural constraint — walks `T` and forces every leaf to be a
// `JsonPrimitive`. Used as a self-referential bound on `TContext`:
//
//     function defineAgent<TContext extends JsonCompatible<TContext>, ...>
//
// Distinct from `T extends JsonObject` because TypeScript does not treat a
// closed object type (no index signature) as structurally assignable to
// `{ [k: string]: JsonValue }` — index-signature compatibility requires a
// declared index signature on the user's type, not just JSON-shaped fields.
// The self-referential bound walks the declared shape directly and avoids
// that mismatch: `{ messages: Message[] }` and
// `interface AgentContext { messages: Message[] }` both pass.
export type JsonCompatible<T> =
    T extends JsonPrimitive ? T :
    T extends ReadonlyArray<infer U> ? ReadonlyArray<JsonCompatible<U>> :
    T extends ReadonlyMap<unknown, unknown> | ReadonlySet<unknown> ? never :
    T extends (...args: never[]) => unknown ? never :
    T extends object ? { [K in keyof T]: JsonCompatible<T[K]> } :
    never;
```

`TContext` is constrained as `TContext extends JsonCompatible<TContext>` — self-referential, recursive. Rejected at compile time: `bigint`, `Date`, `Map`, `Set`, functions, symbols, and any object or class type whose declared shape includes methods, getters, or setters (those members map through `T extends (...args: never[]) => unknown ? never`, infecting the parent type via the mapped-type branch). **Data-only classes are NOT rejected** — TypeScript's structural type system sees no difference between `class Msg { constructor(public role: string, public content: string) {} }` and `{ role: string; content: string }`, and `JSON.stringify` round-trips the data unchanged. The wrapper does not try to distinguish them either; nominal class detection (rejecting any `instanceof Foo` regardless of shape) is out of scope. **`undefined` is admitted explicitly** — declaring `lastReply?: Message` yields `Message | undefined`, both branches valid `JsonCompatible`. At runtime `JSON.stringify` drops keys whose value is `undefined`; that is JavaScript's standard semantic, matches what every persistence layer round-trips, and avoids forcing users into `T | null` boilerplate for optional fields. The cost is a deliberate asymmetry: after `parse(stringify(x))`, optional `undefined` keys are absent rather than `undefined` — the wrapper does not promise reference equality, only structural compatibility with the declared `TContext`.

JSON-safe substitutes for the common rejected types — use these inside `TContext`, and convert at the boundary if a richer runtime shape is needed downstream:

| Rejected                          | Use instead                                                              |
| --------------------------------- | ------------------------------------------------------------------------ |
| `Date`                            | `number` (epoch ms) or `string` (ISO 8601)                               |
| `Map<string, V>`                  | `Record<string, V>`                                                      |
| `Map<K, V>` (non-string key)      | `ReadonlyArray<readonly [K, V]>` entries                                 |
| `Set<T>`                          | `ReadonlyArray<T>` with dedup discipline, or `Record<string, true>`      |
| `bigint`                          | `string` (decimal) when range matters; `number` when it fits in 2^53     |
| class instance                    | the underlying data shape; reconstruct the class at the boundary if needed |

The wrapper does not provide conversion helpers — the substitutes above are plain TypeScript shapes, and the boundary conversion (`Date.parse(ctx.lastSeen)`, `new Map(Object.entries(ctx.byId))`, etc.) is one line at each call site. Centralizing that into wrapper-owned codecs is explicitly out of scope (see §Out of Scope, "custom serializer / deserializer").

Cyclic graphs are not detected by the type system — they still throw at `JSON.stringify` time; the wrapper does not introduce its own cycle detection.

A note on the root: `JSON.stringify(undefined) === undefined` (not the string `"undefined"`), so a literal `TContext = undefined` would not round-trip — the persisted string would itself be `undefined`. In practice `TContext` is always a declared object shape (`{ messages: Message[] }`, etc.); the wrapper does not promise round-trip semantics for a non-object root context, and the constraint walks `T extends object` to enforce the shape inductively.

The exported `JsonObject` / `JsonValue` / `JsonPrimitive` / `JsonArray` stay available as building blocks for users who *want* an open index-signature shape inside their context (e.g. `meta: JsonObject` for arbitrary serializable telemetry, or `Record<string, JsonValue>` for a discriminated bag).

`TPayload` (on `defineLeafMode`) is **not** constrained to `JsonValue`. Reason: the payload is the actor's return value, not context. It only enters context through `routes[*].assign`, whose return type is `Partial<TContext>` — already constrained. Constraining `TPayload` would force discriminated-union payloads (which sometimes carry `Error` instances or other non-JSON values used by `when` predicates) through unnecessary widening.

`TEvents` is **not** constrained. Events are transient; only what `actions` / `assign` write to `TContext` is persisted, and that path is already type-checked against `Partial<TContext>`.

`TDeps` is **not** constrained beyond `Record<string, unknown>`. Deps hold runtime objects with methods (DB driver, logger) — by definition not JSON-serializable. They live outside context.

## Public API Changes

### `defineAgent` — new generic, new field

```ts
export type AgentConfig<
    TContext extends JsonCompatible<TContext>,
    TEvents extends { type: string },
    TModes extends ModesMap<TContext, TEvents, TDeps>,
    TDeps extends Record<string, unknown> = Record<string, never>,
> = {
    id: string;
    initial: keyof TModes & string;
    context: TContext;
    events: TEvents;
    deps?: Readonly<TDeps>;                 // optional; defaults to frozen {}
    actions?: Readonly<Record<
        string,
        (args: { context: TContext; event: TEvents; deps: TDeps }) => Partial<TContext>
    >>;
    modes: TModes;
};

export function defineAgent<
    TContext extends JsonCompatible<TContext>,
    TEvents extends { type: string },
    TModes extends ModesMap<TContext, TEvents, TDeps>,
    TDeps extends Record<string, unknown> = Record<string, never>,
>(
    config: AgentConfig<TContext, TEvents, TModes, TDeps>,
): AnyStateMachine;
```

- `deps` is optional. When omitted, `TDeps` defaults to `Record<string, never>`; user callbacks still receive `deps`, typed as an empty object. This keeps every callback's signature uniform regardless of whether the agent declares dependencies.
- Type/runtime correspondence for the default: `Record<string, never>` makes every property access (`deps.foo`) a compile error (any value type resolves to `never`); the runtime value is `Object.freeze({})`. In normal use these never disagree — TypeScript rejects the access before the runtime value is ever consulted. The two facets are calibrations of the same "no deps" contract, not independent layers.
- `deps` is **immutable after the `defineAgent` call returns** at the container level (see §Imutabilidade).

### `defineLeafMode` — new TDeps generic + deps in callbacks

```ts
// Active form
export type ActiveLeafModeConfig<
    TContext extends JsonCompatible<TContext>,
    TEvents extends { type: string },
    TPayload,
    TDeps extends Record<string, unknown>,
> = {
    input: (args: { context: TContext; deps: TDeps }) => unknown;
    behavior: (args: { input: unknown; deps: TDeps }) => Promise<ModeOutput<TPayload>>;
    routes: Routes<TContext, TPayload, TDeps>;
};

// Passive form
export type PassiveLeafModeConfig<
    TContext extends JsonCompatible<TContext>,
    TEvents extends { type: string },
    TDeps extends Record<string, unknown>,
> = {
    on: EventHandlers<TContext, TEvents, TDeps>;
};

export function defineLeafMode<
    TContext extends JsonCompatible<TContext>,
    TEvents extends { type: string },
    TPayload = unknown,
    TDeps extends Record<string, unknown> = Record<string, never>,
>(
    config: LeafModeConfig<TContext, TEvents, TPayload, TDeps>,
): LeafMode<TContext, TEvents, TPayload, TDeps>;
```

A `LeafMode` carries `TDeps` (on its phantom brand) so that, at slot time inside `defineAgent.modes`, the wrapper can enforce that every mode's `TDeps` is assignable from the agent's `TDeps`. A mode that declares `<C, E, P, { db: Driver }>` cannot be slotted into an agent whose deps lack `db` — the slot is a compile error, not a runtime crash on first call.

**Variance — modes ask for less, agents provide more.** The slot-time check is structural: a `LeafMode<C, E, P, TModeDeps>` fits an agent with `TAgentDeps` when `TAgentDeps` is assignable to `TModeDeps` (i.e. `TAgentDeps` has at least every key in `TModeDeps`, with matching value types). A mode declaring `{ db: Driver }` slots into agents with `{ db, logger }`, `{ db, logger, flags }`, etc., but not into an agent with just `{ logger }`. A mode declaring `Record<string, never>` (the default when `TDeps` is omitted) slots anywhere.

This direction (`TAgentDeps` assignable to `TModeDeps`) is the **opposite** of normal field-position variance. The phantom brand on `LeafMode` / `Mode` puts `TDeps` in **function-argument position** so that the brand is contravariant in `TDeps`, which gives the assignability check the right direction at no syntactic cost:

```ts
export interface LeafMode<TContext, TEvents, TPayload, TDeps> {
    readonly [__leafBrand]: true;
    readonly __phantomLeaf?: { context: TContext; events: TEvents; payload: TPayload };
    readonly __phantomDeps?: (deps: TDeps) => void;     // ← argument position → contravariant
}

export interface Mode<TContext, TEvents, TDeps> {
    readonly [__modeBrand]: true;
    readonly __phantomMode?: { context: TContext; events: TEvents };
    readonly __phantomDeps?: (deps: TDeps) => void;     // ← same
}
```

`(deps: A) => void` is assignable to `(deps: B) => void` iff `B` is assignable to `A` — TypeScript's standard contravariance for function parameters. Applied to the brand, this means `LeafMode<…, AgentDeps>` is assignable to `LeafMode<…, ModeDeps>` iff `AgentDeps` is assignable to `ModeDeps`, which is exactly "agent provides at least every key the mode asks for". Placing `TDeps` inside the covariant `__phantomLeaf` record (alongside `context` / `events` / `payload`) would invert the rule — modes would have to be subtypes-or-equal of the agent's deps, and the wrong slot pairings would compile. The split brand isolates `TDeps` so the variance direction is independent of the other generics.

The dual error (mode needs `db`, agent doesn't have it) surfaces at `defineAgent.modes.foo = thatMode` rather than at the first runtime call.

### `defineMode` — new TDeps generic

```ts
export function defineMode<
    TParentContext extends JsonCompatible<TParentContext>,
    TEvents extends { type: string },
    TCtx extends CompoundContext<TParentContext, ReadonlyArray<keyof TParentContext & string>, object> | undefined,
    TModes extends ModesMap<LocalContextOf<TParentContext, TCtx>, TEvents, TDeps>,
    TDeps extends Record<string, unknown> = Record<string, never>,
>(
    config: ModeConfig<TParentContext, TEvents, TCtx, TModes>,
): Mode<TParentContext, TEvents, TDeps>;
```

`CompoundContext`'s third generic gains the same self-referential bound: `TLocal extends JsonCompatible<TLocal>` (was `TLocal extends object`). Compound-local context lives inside the persisted root context at runtime — per spec 004's "Lexical scoping" → "wrapper allocates a local slot under a generated context key" — and must therefore satisfy the same serializability constraint as the agent's declared `TContext`. The upper bound at `defineMode`'s `TCtx` position stays `object` (the alias-level `JsonCompatible<TLocal>` constraint does the real checking when the user passes their actual local shape).

`Mode<TParentContext, TEvents>` (spec 004, two generics) becomes `Mode<TParentContext, TEvents, TDeps>` with the same `__phantomDeps?: (deps: TDeps) => void` contravariant brand as `LeafMode`. `ModesMap<TContext, TEvents>` becomes `ModesMap<TContext, TEvents, TDeps>` and forwards `TDeps` to every slot — so a single `TDeps` flows from `defineAgent` down through every nested compound's slot map without manual threading at the *slot* type level.

**Manual threading at the `defineMode` *call* level.** Each `defineMode` invocation is independent: TypeScript cannot infer "this sub-mode is being defined for an agent that has `TDeps = { db, logger }`" because the agent does not exist yet at the sub-mode definition site (modes are typically declared in separate files and only referenced from `defineAgent.modes`). A nested compound that uses `deps.db` must declare its own `TDeps` generic explicitly:

```ts
// states/socratic.ts
import type { AgentEvents, AgentContext, AgentDeps } from "../types.js";

export const socratic = defineMode<AgentContext, AgentEvents, undefined,
    { teaching: typeof teaching; listening: typeof listening; evaluating: typeof evaluating },
    AgentDeps>({ /* ... */ });
```

The consumer's project conventionally exports an `AgentDeps` type alias (mirroring `AgentContext` / `AgentEvents`) and imports it at every `defineMode` site. A type-level helper that derives `TDeps` from a back-reference to `defineAgent` (e.g. `DepsOf<typeof agent>`) is **out of scope** — it would require either a circular reference between agent and mode files or a builder-pattern API; both trade spec 004's flat call shape for inference convenience.

### Routes / EventHandlers — `assign` gets deps, `when` stays deps-free

```ts
type ExitEntry<TContext extends JsonCompatible<TContext>, TPayload, TDeps extends Record<string, unknown>> = {
    when?:    (payload: TPayload) => boolean;                                                       // unchanged from 004
    target:   RouteTarget;
    assign?:  (args: { context: TContext; payload: TPayload; deps: TDeps }) => Partial<TContext>;
};

type RetryEntry<TContext extends JsonCompatible<TContext>, TPayload, TDeps extends Record<string, unknown>> = {
    when?:    (payload: TPayload) => boolean;                                                       // unchanged from 004
    assign?:  (args: { context: TContext; payload: TPayload; deps: TDeps }) => Partial<TContext>;
};

type ErrorEntry<TContext extends JsonCompatible<TContext>, TDeps extends Record<string, unknown>> = {
    when?:    (error: unknown) => boolean;                                                          // unchanged from 004
    target:   ErrorRouteTarget;
    assign?:  (args: { context: TContext; error: unknown; deps: TDeps }) => Partial<TContext>;
};

type EventTransition<TContext extends JsonCompatible<TContext>, TEventVariant, TDeps extends Record<string, unknown>> = {
    target?:  RouteTarget;
    actions?: string | readonly string[];
    guard?:   (args: { context: TContext; event: TEventVariant; deps: TDeps }) => boolean;          // gains deps (already had context)
};
```

**`when` predicates stay deps-free** — `(payload) => boolean` and `(error) => boolean`, same as spec 004 §line 191. "Deps-free" means the *signature* exposes neither `deps` nor context — the wrapper does not promise determinism (a `when` can still call `Math.random()` or read a module global; the type system has no way to detect that). The rule is structural: if a routing decision needs a dependency, that signal belongs in `behavior` (which already produces the outcome and has typed access to `deps`), not in the routing layer.

**`assign`, `input`, `behavior`, `actions`, and `guard` receive `{ ..., deps }`** — every callback that already takes a context or event envelope is extended with `deps`. `guard` on event transitions also gains `deps` because it already has access to mutable context — adding `deps` does not change what the callback can observe.

### Imutabilidade — runtime contract

- `defineAgent` calls `Object.freeze(config.deps ?? {})` once and stores the frozen reference. The same reference is passed by identity to every callback for the lifetime of every actor instantiated from this machine.
- Freeze is **shallow**. Reassigning a top-level key (`deps.db = otherDriver`) throws in strict mode. Mutating *inside* a dep value (`deps.db.pool.acquire()`, `deps.logger.buffer.push(...)`) does not — and must not, because the canonical deps (DB drivers, loggers, HTTP clients with keepalive) hold legitimate internal state. The rule the wrapper enforces is: the *set of keys* and the *reference each key binds to* are fixed at machine setup; what those dependencies do internally is the dependency's concern.
- There is no runtime path to override `deps`. `defineAgent` returns a plain `AnyStateMachine` (spec 004 line 236), and `xstate.createActor(machine)` accepts no `deps` parameter — the deps captured in the closure at `defineAgent` time are the only ones any callback ever sees, for the lifetime of every actor instantiated from this machine. Swapping deps requires calling `defineAgent` again with the new container; that is the explicit cost of construction-time deps (deps are fixed at machine-construction time, not user runtime), and is the recipe tests follow (see below).

### Test recipe (informative, not normative)

A one-line factory in the consumer is the standard pattern — extract `defineAgent` into a function that takes `deps` and reuse it across production and test wiring:

```ts
// machine.ts — consumer-owned factory
type Deps = { db: Driver; logger: Logger };

export function makeAgent(deps: Deps) {
    return defineAgent({
        id: "zoe",
        initial: "classifying",
        context: { messages: [] },
        events: {} as AgentEvents,
        deps,
        actions: { /* ... */ },
        modes: { /* ... */ },
    });
}

// production wiring
export const agent = makeAgent({ db: realDb, logger: pino() });

// test wiring — same factory, mocks
export const agentForTests = makeAgent({ db: fakeDb, logger: silentLogger });
```

The wrapper deliberately does not ship `makeAgent` — every consumer's signature differs (its own `Deps` shape, its own `TContext`, its own `actions` table), so a generic helper would either be a thin one-line wrapper or push the consumer back into the same `defineAgent` shape with extra ceremony.

## Mapping: Wrapper → XState

`deps` is **not** stored in XState context. The wrapper closes over the frozen `deps` reference inside `compile.ts` and passes it as an argument to every user callback when it generates the XState side. Specifically:

| Wrapper call site                          | Generated XState shape                                                                          |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `LeafMode.input({ context, deps })`        | `invoke.input = ({ context }) => userInput({ context, deps })` — deps captured in closure       |
| `LeafMode.behavior({ input, deps })`       | `fromPromise(async ({ input }) => userBehavior({ input, deps }))` — deps captured in closure    |
| `routes[outcome][i].when(payload)`         | `onDone[i].guard = ({ event }) => userWhen(event.output.payload)` — no deps in closure          |
| `routes[outcome][i].assign({ ..., deps })` | `onDone[i].actions = assign(({ context, event }) => userAssign({ context, payload: event.output.payload, deps }))` |
| `routes.error[i].when(error)`              | `onError[i].guard = ({ event }) => userWhen(event.error)` — no deps in closure                  |
| `routes.error[i].assign({ ..., deps })`    | `onError[i].actions = assign(({ context, event }) => userAssign({ context, error: event.error, deps }))` |
| `defineAgent.actions[name]({ ..., deps })` | `setup({ actions: { [name]: assign(({ context, event }) => userAction({ context, event, deps })) } })` |
| `on[event].actions: "name"`                | XState `{ on: { [E]: { actions: ["name"] } } }` — the deps closure already lives in `setup.actions[name]`; passive `on` references it by string (DD-004: no inline callbacks here) and inherits the closure automatically |
| `on[event].guard({ ..., deps })`           | XState `{ on: { [E]: { guard: ({ context, event }) => userGuard({ context, event, deps }) } } }` |

`deps` flows through the wrapper's compile output, never through `setup({ types: { context } })`. Context persistence therefore does not include deps: `JSON.stringify(actor.getSnapshot().context)` returns only `TContext` and any compound-local slots (also `JsonCompatible` by constraint).

### Synthetic compound-local slots and persistence

Compound modes that declare `context: { inherit, local }` inject a slot under a generated root-context key (e.g. `__socratic_local`) — see spec 004 §Mapping and `packages/atlas/src/contextLift.ts:42-48`. After this spec the slot value is constrained at the type level (`CompoundContext.local extends JsonCompatible<TLocal>`), so `JSON.stringify(actor.getSnapshot().context)` produces a JSON-compatible value covering both the user's declared `TContext` *and* every synthetic compound-local slot present at the time of the snapshot.

The synthetic keys are **not** part of the user's declared `TContext` type. Three consequences for a persistence layer:

- A layer that wants exact mid-compound restoration must preserve the synthetic keys verbatim — `JSON.parse(json)` returns an object structurally wider than `TContext`, and the wrapper does not strip the extras on rehydrate.
- A layer that restores **only** the user's declared `TContext` (dropping synthetic keys) is safe **only when the persisted snapshot's `value` is outside the owning compound**. In that case the next transition into the compound fires the wrapper's `entry` action (spec 004 line 109) and the slot is re-initialized from `initialLocal`.
- If the snapshot's `value` is *inside* the compound (e.g. `{ socratic: 'evaluating' }`), XState resumes at that state **without re-firing the enclosing compound's `entry` action** — see `packages/atlas/src/contextLift.ts:67-83`, where `buildSubContext` reads `slot = rootContext[lift.key]` and silently skips local-key population when the slot is missing. The child callback then receives a sub-context lacking every local key, which downstream code observes as `undefined` for every `local`-declared field. **Mid-compound persistence therefore MUST preserve the synthetic slot verbatim.** Synthesizing the missing slot at `createActor` time (e.g. via a snapshot inspector) would require the wrapper to own the rehydrate path — out of scope for this spec.

**Scope of the JSON guarantee.** The constraint covers `actor.getSnapshot().context` — the user-declared `TContext` plus any synthetic compound-local slots. XState's full persistence API (`actor.getPersistedSnapshot()`) additionally serializes the event queue, history value, and any in-flight invoke metadata. `TEvents` is intentionally unconstrained (see line on `TEvents` in §New Types), so a persistence layer using `getPersistedSnapshot()` with non-JSON event payloads (e.g. an `Error` instance on the queue) is on its own — `JsonCompatible<TContext>` does not extend to that surface. Reconciling `getPersistedSnapshot` with the JSON contract (typed event serializer, queue filtering) is a future spec when a consumer needs it.

## Migration

Single PR, three layers in order:

1. **`packages/atlas/src/`** — add the `TDeps` generic everywhere; tighten `TContext` to `JsonCompatible<TContext>`; tighten `CompoundContext.local` to `JsonCompatible<TLocal>`; add `deps` to the callback envelopes that mutate or read context (per the table above); thread the closure through `compile.ts`. Add `JsonValue` / `JsonObject` / `JsonPrimitive` / `JsonArray` / `JsonCompatible` exports to `index.ts`. The wrapper's existing tests stay as-is in intent; signatures shift to `{ context, deps }` (or `{ input, deps }`) callbacks and a default-empty `TDeps`.
2. **`examples/zoe/src/`** — confirm the existing context shape satisfies `JsonCompatible<TContext>`: `Message = { role: "user" | "assistant"; content: string }` walks through the recursive bound to leaf primitives ✓. No new deps for Zoe in this spec — the agent still calls module-level `chat()`. `defineAgent` is called without `deps`; the type system supplies `Record<string, never>`. Refactoring Zoe's LLM call into `deps.llm` is **out of scope** here and earns its own spec when there is a reason (e.g. per-mode model selection from §S1).
3. **Docs** — DD recording the JSON constraint, the construction-time deps decision, and the `when`-stays-deps-free decision. Spec 004's prose stays untouched; the index in `docs/specs/README.md` adds row 005.

## File Map

| File                                                | Change                                                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `docs/specs/005-agent-deps-and-stringifiable-context.md` | New spec (this document)                                                                     |
| `docs/specs/README.md`                              | Add row 005, status Draft                                                                         |
| `docs/design-decisions.md`                          | Add DD recording the JSON constraint, construction-time deps, `when`-stays-deps-free decisions    |
| `packages/atlas/src/types.ts`                       | Export `JsonValue` / `JsonPrimitive` / `JsonObject` / `JsonArray` / **`JsonCompatible<T>`**. Constrain `TContext extends JsonCompatible<TContext>` on `AgentConfig`, `Routes`, `EventHandlers`, `ExitEntry`, `RetryEntry`, `ErrorEntry`, `EventTransition`, `ActiveLeafModeConfig`, `PassiveLeafModeConfig`, `LeafModeConfig`, `LeafMode`, `Mode`, `ModesMap`, `ModeConfig`. Constrain `CompoundContext.TLocal extends JsonCompatible<TLocal>`. Add a new `TDeps extends Record<string, unknown>` generic (defaulting to `Record<string, never>`) to all the above; make the brand contravariant in `TDeps` so the slot-time variance from §`defineLeafMode` falls out structurally. Thread `deps` into the argument envelopes of `assign` / `input` / `behavior` / `actions[*]` / `guard`. `JsonPrimitive` now includes `undefined` to admit optional fields (`field?: T`). |
| `packages/atlas/src/defineAgent.ts`                 | Accept `TDeps`; freeze `deps` (or empty object); pass the frozen reference to `compile`            |
| `packages/atlas/src/defineLeafMode.ts`              | Accept `TDeps` generic; brand the returned `LeafMode` with it                                     |
| `packages/atlas/src/defineMode.ts`                  | Accept `TDeps` generic; brand the returned `Mode` with it                                         |
| `packages/atlas/src/compile.ts`                     | Accept `deps` as parameter; thread to `buildActiveState` / `buildPassiveState` / `buildActions`; inject into generated callbacks (input, behavior, routes.*.assign, on.*, actions). `when` predicates remain unchanged (no deps). |
| `packages/atlas/src/buildActions.ts`                | Pass `deps` to user action callbacks                                                              |
| `packages/atlas/src/buildActiveState.ts`            | Inject `deps` into `input`, `behavior`, `routes.*.assign`                                          |
| `packages/atlas/src/buildPassiveState.ts`           | Inject `deps` into `on[*].guard`                                                                  |
| `packages/atlas/src/index.ts`                       | Re-export `JsonValue` family                                                                      |
| `packages/atlas/test/types/*.test-d.ts`             | New cases for the constraints (see §Verification)                                                 |
| `packages/atlas/test/*.test.ts`                     | Updated callback signatures; new tests for the deps closure and freeze behavior                   |
| `examples/zoe/src/states/*.ts`                      | Optional: destructure `deps` if needed (no-op for Zoe today)                                      |
| `examples/zoe/src/machine.ts`                       | No `deps` field; type system supplies `Record<string, never>`                                     |

## Verification

Type-only tests (Vitest `--typecheck`, `.test-d.ts`):

- `TContext` constrained to `JsonCompatible<TContext>` — closed-shape cases compile:
  - `defineAgent({ ..., context: { messages: [] as Message[] } })` (type-alias-shaped literal) compiles.
  - `interface AgentContext { messages: Message[] } ... defineAgent<AgentContext, ...>(...)` (named interface, no index signature) also compiles. This is the case that fails under a flat `extends JsonObject` bound — the recursive `JsonCompatible<T>` constraint is what makes it pass.
- `TContext` rejects non-JSON values:
  - `defineAgent({ ..., context: { lastSeen: new Date() } })` is a compile error.
  - Same for `Map`, `Set`, classes carrying methods/getters/setters (`class Foo { bar() {} }`), `(...args) => unknown`, `bigint`, and `symbol`.
  - A data-only class (`class Msg { constructor(public role: string, public content: string) {} }`) compiles — structural equivalence to `{ role: string; content: string }` means the type system cannot reject it, and the wrapper does not try (§New Types).
- `TContext` admits `undefined` at the leaves:
  - `defineAgent<{ messages: Message[]; lastReply?: Message }, ...>(...)` compiles. `lastReply` resolves to `Message | undefined`; both branches are valid `JsonCompatible`.
  - Round-trip semantics are asserted at runtime (see below): `parse(stringify({ lastReply: undefined }))` is structurally `{}`, not `{ lastReply: undefined }`. The wrapper's contract is structural compatibility, not reference equality.
- `TPayload` is unconstrained: a `defineLeafMode<C, E, { err: Error }>` compiles. The resulting `routes.achieved.assign` only fails if it tries to write the Error into `C` directly.
- `TDeps` defaults to `Record<string, never>` when omitted: `defineAgent({ ... no deps ... })` compiles; user callbacks see `deps` typed as the empty object.
- `TDeps` variance at slot time:
  - Mode with `<C, E, P, { db: Driver }>` slotted into agent with `deps: { db, logger }` compiles (agent provides at least the keys the mode asks for).
  - Same mode slotted into agent with `deps: { logger }` (missing `db`) is a compile error at `defineAgent.modes.foo = thatMode`.
  - Mode with default `Record<string, never>` slots into any agent.
  - **Same-key, incompatible value type**: mode declares `<C, E, P, { db: PgDriver }>`; agent provides `deps: { db: SqliteDriver }` (where `SqliteDriver` is not assignable to `PgDriver`). Compile error at the slot — confirms the assignability check is structural by value type, not nominal by key. Pairs with the contravariant brand from §`defineLeafMode`.
- Compound `local` carries `JsonCompatible<TLocal>`: `defineMode({ context: { inherit: [...], local: { d: new Date() } } })` is a compile error. `local: { attempts: 0 }` compiles; `local: { cursor?: string }` compiles (undefined admitted).
- `routes[*].when` keeps the bare-value signature `(payload) => boolean` / `(error) => boolean`. A user trying to declare `({ payload, deps }) => boolean` is a compile error (parameter shape mismatch).
- `routes[*].assign`, `input`, `behavior`, `actions`, and `EventTransition.guard` callbacks see `deps: TDeps` in their argument envelope. Omitting `deps` from the destructuring is fine (it's just an unused property); referencing a key absent from `TDeps` is a compile error.

Runtime tests:

- `defineAgent` called twice with different `deps` objects produces two machines whose actors observe their own deps reference (no cross-talk).
- The deps reference passed to a callback `===` the reference passed to `defineAgent`.
- `Object.freeze` is applied to the top level of the deps object: assigning `deps.foo = 1` from inside a `behavior` throws in strict mode.
- Mutating *inside* a frozen dep value is allowed: `deps.db.pool.set(...)` on a non-frozen nested object succeeds. Documented as the intentional shape of the contract, not a bug.
- A consumer that omits `deps` sees a frozen `{}` in callbacks (`Object.isFrozen(deps) === true`).
- `JSON.stringify(actor.getSnapshot().context)` for a Zoe actor mid-run produces a string that round-trips through `JSON.parse` to a structurally equal object — confirming no deps leakage into context.
- `undefined` round-trip: a context with `{ a: 1, b: undefined }` stringifies to `{"a":1}` and parses back to `{ a: 1 }`. The wrapper does not promise to restore the `undefined` key — that is JavaScript's `JSON.stringify` semantic and the test asserts the wrapper inherits it unchanged.
- Synthetic slot persistence — outside-the-compound case: enter `socratic` (which declares `local: { attempts: 0 }`), mutate `attempts` to `2`, then exit the compound (e.g. transition to `classifying`) so the snapshot's `value` no longer contains `socratic`. `JSON.stringify(snapshot.context)` includes `__socratic_local: undefined` (cleared by the exit action). After `JSON.parse` and re-creating an actor with that context, re-entering `socratic` re-initializes the slot to `{ attempts: 0 }` via the entry action — confirming the safe path.
- Synthetic slot persistence — inside-the-compound case (negative test): pause inside `socratic.evaluating`, drop `__socratic_local` from the persisted JSON, rehydrate via `createActor(machine, { snapshot })`. A child callback that reads `attempts` sees `undefined` — XState does not re-fire `socratic`'s entry action on resume. The test asserts the documented limitation (mid-compound persistence MUST preserve the synthetic slot verbatim), not a wrapper guarantee.
- A `routes.achieved.when` defined as `(payload) => payload.intent === "x"` still routes correctly post-spec (regression: confirm the bare-value shape compiled away cleanly).

Existing Zoe scenarios from spec 003 §Verification continue to pass unchanged — this spec changes types and adds a closure parameter, not behavior.

## Out of Scope

- Refactoring `chat()` into a `deps.llm` injection. Worth a separate spec only when a concrete need (per-mode model, test isolation across modes) lands.
- Runtime override of `deps` via a `createAgentActor` parameter. Explicitly rejected per §Imutabilidade; revisit only if a real use case for swapping deps on an existing machine appears.
- Deep-freezing `deps`. Explicitly rejected per §Imutabilidade — would break the canonical dep examples (DB driver, logger).
- A custom serializer / deserializer pair on `defineAgent`. With `TContext extends JsonCompatible<TContext>` the contract is "raw JSON works"; introducing a serializer layer is a future spec if a consumer needs e.g. compression or schema-versioned encoding.
- Renaming `TContext` / `defineAgent.context` to `*State`. Considered and rejected — would overload "state" with two existing meanings at the XState boundary (`state.value`, `Snapshot`) for cosmetic gain only. The persistability motivation is fully captured by the `JsonCompatible<T>` constraint, not the name. (`AgentContext` in `examples/zoe/src/types.ts` is the consumer's local alias and is out of scope for this spec either way.)
- Renaming `ModeOutput`. Stable; payload is not context.
