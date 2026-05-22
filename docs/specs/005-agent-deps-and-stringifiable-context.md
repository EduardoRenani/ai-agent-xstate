# 005 — Agent Deps & Stringifiable Context

## Status

Draft. Depends on 004 (XState Agent Wrapper). Purely additive: no renames, no field changes. Only constrains an existing generic and adds a new one.

## Goal

Two coupled additions to the `atlas` wrapper, both extending the public API without renaming anything:

1. **Constrain** `TContext` at the type level to a JSON-serializable shape (`JsonObject`), so any agent context can round-trip through arbitrary storage (file, KV, blob, message broker) without the wrapper or the consumer doing custom encoding.
2. **Add** `AgentDeps` — a typed, immutable dependency container declared on `defineAgent` and threaded through every user callback that mutates or reads context. Provides access to external resources (DB driver, logger, LLM client) without module-global coupling. Optional field with a typed empty default.

After this spec, the wrapper's three constructors carry an extra `TDeps` generic: `<TContext, TEvents, TModes, TDeps>` on `defineAgent`, `<TContext, TEvents, TPayload, TDeps>` on `defineLeafMode`, `<TParentContext, TEvents, TCtx, TModes, TDeps>` on `defineMode`. All existing names — `AgentContext`, `TContext`, `TParentContext`, `CompoundContext`, `LocalContextOf`, the `context` field on `AgentConfig` / `ModeConfig` — are preserved.

## Problems Addressed

### P5 — `TContext` admits non-serializable shapes silently

Spec 004's `TContext` is unconstrained (`AgentConfig<TContext, ...>`). Today's Zoe context happens to be `{ messages: Message[] }` — JSON-safe by accident, not by contract. A future mode can add `lastSeen: Date`, `pendingCalls: Map<string, Promise>`, or a class instance, and nothing flags it until the agent is persisted and `JSON.stringify` either drops the field (`Map` → `{}`), produces a lossy string (`Date` → ISO string but parses back as string), or throws (cyclic). Storage-backed flows must catch this at the type level, not at the first checkpoint.

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

`TContext` is constrained as `TContext extends JsonCompatible<TContext>` — self-referential, recursive. Rejected at compile time: `bigint`, `Date`, `Map`, `Set`, class instances, functions, and symbols. **`undefined` is admitted explicitly** — declaring `lastReply?: Message` yields `Message | undefined`, both branches valid `JsonCompatible`. At runtime `JSON.stringify` drops keys whose value is `undefined`; that is JavaScript's standard semantic, matches what every persistence layer round-trips, and avoids forcing users into `T | null` boilerplate for optional fields. The cost is a deliberate asymmetry: after `parse(stringify(x))`, optional `undefined` keys are absent rather than `undefined` — the wrapper does not promise reference equality, only structural compatibility with the declared `TContext`.

Cyclic graphs are not detected by the type system — they still throw at `JSON.stringify` time; the wrapper does not introduce its own cycle detection.

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

**Variance — modes ask for less, agents provide more.** The slot-time check is structural: a `LeafMode<C, E, P, TModeDeps>` fits an agent with `TAgentDeps` when `TAgentDeps` is assignable to `TModeDeps` (i.e. `TAgentDeps` has at least every key in `TModeDeps`, with matching value types). A mode declaring `{ db: Driver }` slots into agents with `{ db, logger }`, `{ db, logger, flags }`, etc., but not into an agent with just `{ logger }`. A mode declaring `Record<string, never>` (the default when `TDeps` is omitted) slots anywhere. The phantom brand on `LeafMode` / `Mode` is contravariant in `TDeps` so this falls out structurally — no explicit `Partial<>` wrapping at the slot type. The dual error (mode needs `db`, agent doesn't have it) surfaces at `defineAgent.modes.foo = thatMode` rather than at the first runtime call.

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

### Routes / EventHandlers — `assign` gets deps, `when` stays pure

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

**`when` predicates stay pure** — `(payload) => boolean` and `(error) => boolean`, same as spec 004 §line 191. They classify the outcome and nothing more; if a routing decision needs to consult a dependency, that is a sign the decision belongs in `behavior` (which already produces the outcome), not in the routing layer.

**`assign`, `input`, `behavior`, `actions`, and `guard` receive `{ ..., deps }`** — every callback that already takes a context or event envelope is extended with `deps`. `guard` on event transitions also gains `deps` because it already has access to mutable context — adding `deps` does not change its purity envelope.

### Imutabilidade — runtime contract

- `defineAgent` calls `Object.freeze(config.deps ?? {})` once and stores the frozen reference. The same reference is passed by identity to every callback for the lifetime of every actor instantiated from this machine.
- Freeze is **shallow**. Reassigning a top-level key (`deps.db = otherDriver`) throws in strict mode. Mutating *inside* a dep value (`deps.db.pool.acquire()`, `deps.logger.buffer.push(...)`) does not — and must not, because the canonical deps (DB drivers, loggers, HTTP clients with keepalive) hold legitimate internal state. The rule the wrapper enforces is: the *set of keys* and the *reference each key binds to* are fixed at machine setup; what those dependencies do internally is the dependency's concern.
- The wrapper does not allow `createAgentActor` (or any runtime path) to override `deps`. There is no `withDeps(...)` helper, no `createAgentActor(machine, { deps })` parameter. Swapping deps requires calling `defineAgent` again — that is the explicit cost of "compile-time" deps, and is the recipe tests follow (see below).

### Test recipe (informative, not normative)

```ts
// production wiring
export const agent = defineAgent({
    /* ... */,
    deps: { db: realDb, logger: pino() },
});

// test wiring — same shape, mocks
export const agentForTests = defineAgent({
    /* ... same id, context, events, actions, modes ... */,
    deps: { db: fakeDb, logger: silentLogger },
});
```

A reusable `makeAgent(deps)` factory in the consumer is the standard pattern. The wrapper does not provide it.

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
| `on[event].guard({ ..., deps })`           | XState `{ on: { [E]: { guard: ({ context, event }) => userGuard({ context, event, deps }) } } }` |

`deps` flows through the wrapper's compile output, never through `setup({ types: { context } })`. Context persistence therefore does not include deps: `JSON.stringify(actor.getSnapshot().context)` returns only `TContext` and any compound-local slots (also `JsonCompatible` by constraint).

### Synthetic compound-local slots and persistence

Compound modes that declare `context: { inherit, local }` inject a slot under a generated root-context key (e.g. `__socratic_local`) — see spec 004 §Mapping and `packages/atlas/src/contextLift.ts:42-48`. After this spec the slot value is constrained at the type level (`CompoundContext.local extends JsonCompatible<TLocal>`), so `JSON.stringify(actor.getSnapshot().context)` produces a JSON-compatible value covering both the user's declared `TContext` *and* every synthetic compound-local slot present at the time of the snapshot.

The synthetic keys are **not** part of the user's declared `TContext` type. Two consequences for a persistence layer:

- A layer that wants exact mid-compound restoration must preserve the synthetic keys verbatim — `JSON.parse(json)` returns an object structurally wider than `TContext`, and the wrapper does not strip the extras on rehydrate.
- A layer that restores **only** the user's declared `TContext` (dropping synthetic keys) is still safe — the wrapper's `entry` action re-initializes the slot from `initialLocal` on next entry to that compound (spec 004 line 109), so missing synthetic keys after restore are not fatal: they re-materialize on the next entry to that compound. The trade-off (exact-state vs. user-shape-only) is the persistence layer's decision, not the wrapper's.

## Migration

Single PR, three layers in order:

1. **`packages/atlas/src/`** — add the `TDeps` generic everywhere; tighten `TContext` to `JsonObject`; tighten `CompoundContext.local` to `JsonObject`; add `deps` to the callback envelopes that mutate or read context (per the table above); thread the closure through `compile.ts`. Add `JsonValue` / `JsonObject` / `JsonPrimitive` / `JsonArray` exports to `index.ts`. The wrapper's existing tests stay as-is in intent; signatures shift to `{ context, deps }` (or `{ input, deps }`) callbacks and a default-empty `TDeps`.
2. **`examples/zoe/src/`** — confirm the existing context shape satisfies `JsonObject`: `Message = { role: "user" | "assistant"; content: string }` is JSON-safe; `messages: Message[]` is `JsonValue[]` → `JsonValue` ✓. No new deps for Zoe in this spec — the agent still calls module-level `chat()`. `defineAgent` is called without `deps`; the type system supplies `Record<string, never>`. Refactoring Zoe's LLM call into `deps.llm` is **out of scope** here and earns its own spec when there is a reason (e.g. per-mode model selection from §S1).
3. **Docs** — DD recording the JSON constraint, the compile-time deps decision, and the `when`-stays-pure decision. Spec 004's prose stays untouched; the index in `docs/specs/README.md` adds row 005.

## File Map

| File                                                | Change                                                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `docs/specs/005-agent-deps-and-stringifiable-context.md` | New spec (this document)                                                                     |
| `docs/specs/README.md`                              | Add row 005, status Draft                                                                         |
| `docs/design-decisions.md`                          | Add DD recording the JSON constraint, compile-time deps, `when`-stays-pure decisions              |
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
  - Same for `Map`, `Set`, class instances, `(...args) => unknown`, `bigint`, and `symbol`.
- `TContext` admits `undefined` at the leaves:
  - `defineAgent<{ messages: Message[]; lastReply?: Message }, ...>(...)` compiles. `lastReply` resolves to `Message | undefined`; both branches are valid `JsonCompatible`.
  - Round-trip semantics are asserted at runtime (see below): `parse(stringify({ lastReply: undefined }))` is structurally `{}`, not `{ lastReply: undefined }`. The wrapper's contract is structural compatibility, not reference equality.
- `TPayload` is unconstrained: a `defineLeafMode<C, E, { err: Error }>` compiles. The resulting `routes.achieved.assign` only fails if it tries to write the Error into `C` directly.
- `TDeps` defaults to `Record<string, never>` when omitted: `defineAgent({ ... no deps ... })` compiles; user callbacks see `deps` typed as the empty object.
- `TDeps` variance at slot time:
  - Mode with `<C, E, P, { db: Driver }>` slotted into agent with `deps: { db, logger }` compiles (agent provides at least the keys the mode asks for).
  - Same mode slotted into agent with `deps: { logger }` (missing `db`) is a compile error at `defineAgent.modes.foo = thatMode`.
  - Mode with default `Record<string, never>` slots into any agent.
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
- Synthetic slot persistence: enter `socratic` (which declares `local: { attempts: 0 }`), mutate `attempts` to `2` via a route assign, then `JSON.stringify(snapshot.context)`. The output includes `__socratic_local: { attempts: 2 }`. After `JSON.parse` and re-creating an actor with that context, re-entering socratic re-initializes the slot to `{ attempts: 0 }` (entry action runs) — confirming the "missing synthetic keys are not fatal" claim from §Mapping.
- A `routes.achieved.when` defined as `(payload) => payload.intent === "x"` still routes correctly post-spec (regression: confirm the bare-value shape compiled away cleanly).

Existing Zoe scenarios from spec 003 §Verification continue to pass unchanged — this spec changes types and adds a closure parameter, not behavior.

## Out of Scope

- Refactoring `chat()` into a `deps.llm` injection. Worth a separate spec only when a concrete need (per-mode model, test isolation across modes) lands.
- Runtime override of `deps` via a `createAgentActor` parameter. Explicitly rejected per §Imutabilidade; revisit only if a real use case for swapping deps on an existing machine appears.
- Deep-freezing `deps`. Explicitly rejected per §Imutabilidade — would break the canonical dep examples (DB driver, logger).
- A custom serializer / deserializer pair on `defineAgent`. With `TContext extends JsonCompatible<TContext>` the contract is "raw JSON works"; introducing a serializer layer is a future spec if a consumer needs e.g. compression or schema-versioned encoding.
- Renaming `TContext` / `defineAgent.context` to `*State`. Considered and rejected — would overload "state" with two existing meanings at the XState boundary (`state.value`, `Snapshot`) for cosmetic gain only. The persistability motivation is fully captured by the `JsonCompatible<T>` constraint, not the name. (`AgentContext` in `examples/zoe/src/types.ts` is the consumer's local alias and is out of scope for this spec either way.)
- Renaming `ModeOutput`. Stable; payload is not context.
