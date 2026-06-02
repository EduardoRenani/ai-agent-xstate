# Design Decisions

## 001 — No cross-boundary sub-state targeting

**Date:** 2026-05-14

**Rule:** Transitions must never target a child sub-state of another compound state. Always target the parent and let it route internally via its `initial` state.

**Problem:** If `greetings` targets `#agent.improvising.thinking` directly, it knows `improvising`'s internal structure. Reorganizing `improvising`'s children silently breaks `greetings`.

**Solution:** Every mode exits through a `done` state of type `final`. The parent compound state handles `onDone` uniformly — transition to `classifying`. No mode decides what comes next; the classifier handles all routing. No state knows the internal structure of another.

**Rejected alternatives:**
- **Absolute ID targeting** (`#agent.improvising.thinking`): couples the source to the target's internal structure.
- **`always` guard in child state**: moves the coupling to the target — the child carries routing logic that only exists to serve the source. A state should not carry guards that compensate for another state's transition intent.
- **Flag + guard**: a boolean in context (e.g. `unprocessedMessage`) checked by an `always` guard. This is an antipattern — it encodes control flow in data instead of using events and transitions. See decision 006.

## 002 — States are agent modes

**Date:** 2026-05-14

**Principle:** Each state represents a mode of the agent. The agent's behavior in that mode is contained within the state — either as a single state with actions/invoke, or as compound sub-states. There is always a behavior (sync or async code) followed by a transition.

**Implications:**
- State names should describe the agent's mode, not the technical operation. `thinking` (what the agent is doing) instead of `calling` (what function is running).
- `listening` (the agent is available for input) instead of `waiting` (passive, technical).
- Actors defined in `setup()` are a framework requirement, but conceptually each actor belongs to the state that invokes it. As the agent grows, different states will have different LLM configurations (system prompt, tools, model).

## 003 — Thinking/Listening pattern

**Date:** 2026-05-14

**Pattern:** When the agent needs to process without interruption, split into two sub-states: `thinking` (invoke, does not handle input) and `listening` (accepts input, no invoke). This is the default for most agent modes.

**When to use:** The agent is performing work where interruption would be wasteful or confusing — e.g. generating a conversational response. Accidental input would cancel the in-flight response, lose the pending answer, and waste API calls.

**Alternative — interruptible state:** When the agent should accept new input during processing (e.g. urgent/critical messages that override the current task), use a single state with `invoke` + `on.MESSAGE` as a self-transition. The new message cancels the in-flight invoke and restarts it. This is a deliberate design choice, not a default.

**Decision for one-shot modes (`greetings`, `improvising`):** ~~These modes use thinking → done (final) without an internal listening state.~~ **Superseded by DD-026** — these are now leaf modes (no internal substate at all), since a single-substate compound that never handles `MESSAGE` is redundant. The interruption-safety argument still holds: the root `listening` is a sibling, not a parent, so `MESSAGE` events never reach a one-shot mode's invoke while it runs (XState sibling isolation).

**Decision for multi-turn modes (`socratic`):** Uses thinking/listening internally because the mode requires multiple exchanges with the user. The internal `listening` accepts `MESSAGE` and continues within the mode. The root `listening` remains inactive while inside the mode.

## 004 — setup() is for structural/generic actions, not agent behavior

**Date:** 2026-05-14

**Rule:** Only actions that are reusable and structural/generic (not defining the agent's behavior in a specific state) go in `setup()`. Actions that define what the agent does in a state stay inline in that state.

**Example:** `appendUserMessage` is structural — it appends a message to the conversation history. It doesn't define what the agent does, it's plumbing that multiple states need. It belongs in `setup()`.

**Counter-example:** The `console.log` in `thinking`'s `onDone` (printing the LLM reply) is the agent's behavior in that state — it's how the agent responds. It stays inline even if it were used only once.

**Rationale:** Each state should contain its own behavior visibly. Extracting behavior into `setup()` separates the "what" from the "where", making the machine harder to read as a description of agent modes. `setup()` is infrastructure; states are behavior.

## 005 — System prompts are per-state constants in the machine module

**Date:** 2026-05-14

**Rule:** Each state that invokes the LLM defines its own system prompt as a module-level constant in `machine.ts`. System prompts are not stored in context, not passed from `index.ts`, and not placed in `setup()`.

**Rationale:** A system prompt defines the agent's behavior in a specific state — it tells the LLM what mode the agent is in. Per design decision 002, states are agent modes, so the system prompt is part of the state's behavior data. Placing prompts as module-level constants keeps them visible near the machine definition without cluttering `setup()` (which is for structural/generic infrastructure, per decision 004).

**Why not in context:** System prompts are static per state, not accumulated data. Context is for data that evolves across transitions (like `messages`). Mixing static configuration with dynamic state would blur the distinction.

**Why not in `setup()`:** `setup()` is for reusable structural elements (actions, actors, guards). A system prompt is specific to one state's invocation — it is behavior, not infrastructure.

## 006 — Events are facts

**Date:** 2026-05-14

**Principle:** Events represent facts — something that happened. They are named in past tense or as factual observations (`MESSAGE`), never as imperative commands (`CONTINUE`, `PROCESS`, `START`). The machine's behavior is determined by which events it accepts and how it reacts, not by being told what to do.

**Naming test:** If an event name reads as an order to the machine ("do this"), it is wrong. It should read as a report ("this happened"). `MESSAGE` is a fact — the user sent a message. `CONTINUE` is a command — it tells the machine what to do next.

## 007 — Flag + guard is an antipattern for control flow

**Date:** 2026-05-14

**Rule:** Do not use booleans in context combined with `always` guards to route transitions between states.

**Problem:** A flag (e.g. `unprocessedMessage: boolean`) set by one state and read by an `always` guard in another encodes control flow in data. The causal link between states is invisible in the state chart — it only appears by tracing context mutations. Debugging requires reading the code instead of reading the chart.

**Correct alternative:** Use events and transitions. The causal link is explicit and visible in the state chart. With the current architecture, mode completion flows through `onDone` of the compound state to `classifying`, which routes based on the classifier's output — no flags needed.

**Example:** `greetings` completes and transitions to its `done` (final) sub-state. The parent's `onDone` routes to `classifying`, which determines the next mode. No flag needed — the state chart structure is the signal, and context (messages) provides the data.

## 008 — Actor names mirror their state path

**Date:** 2026-05-14

**Rule:** An actor defined in `setup().actors` must be named after the state path that invokes it. A top-level state uses the state name directly (`greetings`). A nested state uses camelCase of the path (`improviseThinking` for `improvise.thinking`).

**Rationale:** An invoke actor is the async behavior of a state (decision 002). XState's `setup()` forces actors to be declared separately from the states that use them, but conceptually they are coupled — the actor *is* what the state does. Naming the actor after its state makes this coupling explicit: reading `src: "improviseThinking"` immediately tells you this is the behavior of `improvise.thinking`, and reading the actor definition at the top of the module tells you which state it belongs to.

**Naming convention:**
- Top-level state: actor name = state name + `Node` suffix. `greetings` state → `greetingsNode` actor.
- Nested state: actor name = camelCase of the full path + `Node` suffix. `improvise.thinking` state → `improviseThinkingNode` actor.

The `Node` suffix disambiguates the actor (the async behavior) from the state itself and signals that this is the executable node of that state.

**What this means for `setup()`:** The actors map becomes a thin registry of name→reference pairs. Each actor is defined next to its system prompt and tools (per decisions 005 and 009), grouped by the state it belongs to.

## 009 — State artifacts live in dedicated state files

**Date:** 2026-05-14

**Rule:** Each state that has an invoked actor gets its own file containing all artifacts coupled to that state. The file is named `<outerstate>.<innerstate>.state.ts` for nested states, or `<state>.state.ts` for top-level states.

**What a state file defines:** The *behavior* of the agent in that state/mode. Behavior is expressed by three artifacts:
- **Actor** — the async logic that runs when the state is entered.
- **System prompt** — tells the LLM what mode the agent is in and how to behave.
- **Tools** — what the agent can do in that mode (capabilities available to the LLM).

These three artifacts are inseparable — together they define *what the agent does* in a given state. That is why they live in the same file.

**Examples:**
- `classifying` → `src/states/classifying.state.ts`
- `greetings.thinking` → `src/states/greetings.thinking.state.ts`
- `socratic.teaching` → `src/states/socratic.teaching.state.ts`
- `improvising.thinking` → `src/states/improvising.thinking.state.ts`

**What a state file exports:** The actor (e.g. `greetingsNode`). System prompts and tools are private to the file — they are implementation details of the actor's behavior.

**Rationale:** XState's `setup()` forces actors to be declared separately from the states that invoke them (decision 008). As the agent grows, keeping all actors and their prompts/tools in `machine.ts` makes it unreadable. Separating into state files preserves the conceptual coupling (the actor *is* what the state does) while keeping `machine.ts` focused on the machine structure: states, transitions, and context.

**What stays in `machine.ts`:**
- The machine definition (`setup()` + `createMachine()`)
- Structural actions (e.g. `appendUserMessage`)
- Type definitions (`LLMInput`, context type)
- Imports of actors from state files and their registration in `setup().actors`

**Supersedes:** Decision 005's clause "module-level constant in `machine.ts`" is superseded — prompts now live in the state file, not in `machine.ts`. The principle remains (prompts are per-state, not in context), only the location changes.

## 010 — Invoke/onDone/guard is the transition routing pattern

**Date:** 2026-05-15

**Pattern:** A state's behavior is an invoked actor. The transition after completion is decided by an ordered guard array on `onDone`, where each guard inspects `event.output` — the actor's return value. First match wins; the last entry has no guard (default/fallback).

**Structure:**
```
state → invoke actor → onDone: [
    { guard: output === X → target A },
    { guard: output === Y → target B },
    { (no guard, default) → target C },
]
```

**Why inline guards:** Guards on `onDone` are behavioral — they express "given this output, go there". Per decision 004, behavioral logic stays inline in the state, not in `setup()`. Registering guards in `setup()` would separate the routing decision from the transition it controls, making the machine harder to read as a flow.

**Why guard on output, not separate events:** The actor produces a single `onDone` event with structured output. Splitting into multiple event types (e.g. `GREETINGS_CLASSIFIED`, `SOCRATIC_CLASSIFIED`) would couple the actor to the machine's state topology — the actor would need to know what states exist. With output + guards, the actor returns data and the machine decides.

**Rejected alternatives:**
- **Guards in `setup()`:** Adds indirection. Reading `type: "isGreetingsIntent"` forces you to look up the guard definition to understand a simple `=== "greetings"` check. Inline guards are self-documenting at the point of use.
- **One event per outcome:** Couples the actor to the machine topology (see above).
- **Flag + always guard:** Antipattern per decision 007.

## 011 — Side effects belong in the actor, not in onDone

**Date:** 2026-05-15

**Rule:** Observable side effects of a state's behavior (e.g. printing the agent's response to the user) are performed inside the invoked actor, not in `onDone` actions.

**What stays in `onDone`:** Plumbing (assign output to context) and routing (guard + target). Nothing else.

**Rationale:** Per decision 002, a state is an agent mode and the invoked actor *is* the agent's behavior in that mode (decision 009). "Speaking to the user" is behavior — it is part of what the agent does, not a transition concern. Placing it in `onDone` separates the behavior from the actor that produces it.

**Rejected alternative:**
- **Side effects in onDone actions:** Mixes behavioral side effects with transition plumbing. The actor already has the data and the context to perform the effect — `onDone` should not carry behavior that belongs to the mode.

## 012 — Agent modes are expressed through a typed wrapper, not raw XState

**Date:** 2026-05-20

**Rule:** Agent code expresses its modes through the `atlas` library (`defineMode`, `defineCompoundMode`, `defineAgent`) — not through raw XState `setup()` / `createMachine()` / `fromPromise` / `assign` / `onDone` arrays. Importing from `xstate` inside agent source is a wrapper bug, not an escape hatch.

**Rationale:** Decisions 008-011 codify a recurring shape: each state owns an invoked actor (DD-008), the actor and its prompt live together in a state file (DD-009), the transition after completion is decided by an ordered guard array on `onDone` (DD-010), and side effects are performed inside the actor (DD-011). Expressed in raw XState, that shape forces four separate hand-written pieces per mode — actor registration in `setup({ actors })`, the invoke block, the `onDone` guard array reading `event.output`, and the manual `assign` for context merging — held together by naming convention rather than by the type system. As the agent grows, the boilerplate scales linearly with the mode count and the `event.output` access stays untyped at every site.

The wrapper takes the shape that DD-008-011 already mandate and makes it the only way to express a mode. `defineMode` returns a single object holding `input`, `behavior`, and `routes` (a four-key map: `achieved` / `retry` / `abandoned` / `error`); the wrapper compiles this to the equivalent XState configuration. Actor names are derived from the state path (DD-008 becomes an invariant enforced by the compiler, not a convention enforced by review). The `routes` map closes over a typed `payload`, so `event.output` casts disappear at every call site. Side effects continue to live inside `behavior` (DD-011 unchanged).

The output of `defineAgent` is a standard XState machine, so `createActor`, the inspector API, and existing tests keep working unchanged. The library is pure compile-time sugar — at runtime there is no extra layer.

**Scope:** Spec 004 defines the contract; the spec-004 implementation migrates every Zoe state to the wrapper — `classifying`, `greetings.thinking`, `improvising.thinking`, the root `listening`, and the `socratic` compound (`socratic.teaching`, `socratic.listening`, `socratic.evaluating`). The original concern — that `socratic.evaluating`'s sideways-jump retry to the `teaching` sibling did not map cleanly to the wrapper's structural retry-as-self-loop (DD-014) — was resolved by encoding the model's three results (`achieved` / `retry` / `abandoned`) in the leaf's payload and dispatching from `routes.achieved`. The wrapper-retry-is-a-self-loop constraint is honored; sibling-target branching lives in the payload.

**Supersedes:** Nothing. DD-008 through DD-011 stay in force; the wrapper is how they get expressed, not what they say. DD-009's file-naming convention is restated by the wrapper (`<state>.ts` under `examples/zoe/src/states/`); the `.mode.ts` suffix used by the pre-migration code has been dropped across the package.

## 013 — `Outcome` is a closed four-slot record

**Date:** 2026-05-20

**Rule:** `Routes<TContext, TPayload>` is keyed by a closed `Outcome = "achieved" | "retry" | "abandoned"` plus the separate optional `error` slot — never freeform. Consumers cannot extend the set.

**Rationale:** A closed key set makes every routes value statically inspectable as a four-key record, lets each slot carry different semantics (retry is structurally a self-loop per DD-014; `error` sees `error: unknown`, the others see `payload: TPayload`), and forces an exhaustive routing vocabulary. Behaviors that don't fit the three positive outcomes either encode the discrimination in the payload and dispatch from `routes.achieved` with a guarded array (`examples/zoe/src/states/socratic.evaluating.ts`) or split into multiple leaves.

**Rejected alternatives:**
- **Freeform `Record<string, RouteEntry>`:** Loses per-slot type narrowing (retry-no-target, error-sees-rejection). The same payload-encoded dispatch would still be available but with looser types.
- **`Outcome` as a string-literal union the user can extend:** Leaks the abstraction — which outcomes are framework-owned vs. user-owned at the type level?

## 014 — Retry is structurally a self-loop on the same leaf

**Date:** 2026-05-20

**Rule:** `RetryEntry` does NOT carry a `target` field — supplying one is a compile error. Every entry in `routes.retry` is a structural self-loop on the leaf that owns the routes.

**Rationale:** "Retry" semantically means re-run the same behavior, not "branch by outcome name to a different state". Allowing retry to target a sibling would collapse retry's identity into something `achieved` or `abandoned` already does. When the actual control flow needs to branch on an evaluator's verdict to a sibling state, the leaf encodes the discriminator in its payload and dispatches from `routes.achieved`. The canonical worked example is `socratic.evaluating`: the model's three results (`achieved` / `retry` / `abandoned`) live in `{ result }`, and `routes.achieved` dispatches `result === "retry" → "teaching"` (sibling), the other two → `END`. The wrapper-retry constraint is preserved; sibling-target branching lives in the payload.

**Rejected alternatives:**
- **Allow `RetryEntry.target`:** Erases the semantic distinction between retry and the other slots. If retry can branch, the four slots collapse into "four ways to spell a guarded transition" and the type contract loses meaning.

## 015 — `END` and `RE_THROW` are opaque branded symbols

**Date:** 2026-05-20

**Rule:** `END` (compound-final exit) and `RE_THROW` (re-raise the captured rejection) are exported by `atlas` as opaque branded symbols (`unique symbol` + `type END = typeof END`). Their types appear in `RouteTarget = string | END` and `ErrorRouteTarget = string | END | RE_THROW`. Users cannot construct an `END` or `RE_THROW` value without importing it.

**Rationale:** Encoding `END` as a reserved string (`"END"`, `"$end"`, etc.) would collide with user-named states, require runtime validation to forbid the reserved name, and lose type-level discrimination — the compiler could not distinguish "an end exit" from "a target whose name happens to be `$end`". As opaque symbols, `END` and `RE_THROW` are identity-comparable in the compiler and mechanically excluded from slots they don't belong to (e.g. `RE_THROW` on non-error routes is a compile error because `RouteTarget` does not include it).

**Rejected alternatives:**
- **Reserved strings:** Still string-typed, still forgeable, still collidable.
- **A literal type like `END = "@@atlas/end"`:** Better than freeform strings but still constructible by anyone who knows the magic string.

## 016 — Target resolution is sibling-name only

**Date:** 2026-05-20

**Rule:** A `target` string must name a key in the **immediate** enclosing `states` map. Dotted paths, `#`-prefixed absolute IDs, and unknown-sibling targets are rejected by `validateTargets` at machine-creation time. The error message names the offending leaf path, the slot (`routes.<group>[i]`, `on.<EVENT>[i]`, or `onDone`), and the literal bad target.

**Rationale:** Promotes DD-001 ("No cross-boundary sub-state targeting") from a code-review rule to a compiler invariant. The original problem — a target like `#agent.improvising.thinking` coupling the source to the target's internal structure — becomes unwritable. Compounds expose exactly one exit per slot (`onDone`); cross-compound flow goes through the parent. `END` (DD-015) and the structural retry self-loop (DD-014) cover the two non-sibling shapes that DO have legitimate uses; everything else stays sibling-only.

**Rejected alternatives:**
- **Allow absolute-ID targets for "escape hatches":** Every escape hatch grows usage. Forcing legitimate cross-compound flow through the parent's `onDone` is what makes DD-001 hold.
- **Allow dotted paths for nested-child targeting within the same compound:** The same coupling problem at a smaller scale.

## 017 — `END` is injected per-compound, only when referenced

**Date:** 2026-05-20

**Rule:** When a compound's subtree references `target: END` anywhere (leaf routes or nested-compound `onDone`), the compiler injects one final substate into that compound's `states` map under a collision-safe name (`$end`, `$end1`, ...) and rewrites every `END` target in that level to that key. Compounds whose subtrees never reference `END` get no injection — they stay "open", with no final substate emitted.

**Rationale:** `END` is a relative exit — it means "leave the enclosing compound", which the compound's own `onDone` then routes from. Each compound that needs to exit on completion needs its own final substate to fire `onDone`. A single global `$end` at the root would short-circuit inner compounds to the root, defeating per-compound routing. Always injecting `$end` everywhere would pad every compound with unused final nodes that pollute the inspector and test snapshots. "Inject only when referenced" keeps the emitted machine the minimal equivalent of what the user wrote.

**Rejected alternatives:**
- **Single global `$end` at the root:** Doesn't compose for nested compounds.
- **Always inject `$end` in every compound:** Pads the emitted machine with dead state nodes.

## 018 — Compound-local context is a lifted root-context slot

**Date:** 2026-05-20

**Rule:** When a `defineCompoundMode` compound declares `context: { inherit, local }`, the compiler allocates a generated key on the agent's flat root context (`__<path>_local`, e.g. `__socratic_local`) holding the `local` shape, emits an `entry` action initializing it from the declared defaults, and emits an `exit` action clearing it. Children inside the compound see a typed view of `Pick<TParent, inherit> & local` in their `input` / `assign` / `when` / `guard` callbacks; the compiler rewrites their reads and writes to hit the lifted slot. Nested compounds chain via a `parent` lift, so an inner write to an outer compound's local key routes to the outer compound's slot, not the agent root.

**Rationale:** XState v5 has a single flat context — there is no native per-state context. To honor the wrapper's type contract that gives every compound a logically scoped view, the compiler synthesizes the scope by lifting to a uniquely-named root-context slot. Reads and writes are rewritten at compile time; out-of-scope writes from a child (a write to a parent key that wasn't declared `inherit`) are silently dropped by `splitUserUpdate`, so they cannot reach the actual context. The type system already rejects the same writes at the call site; the runtime drop is belt-and-suspenders against `as Routes<...>` cast bypasses.

**Rejected alternatives:**
- **Store per-compound context as a state-tree property:** XState v5 does not support this; reimplementing it would require a parallel state machine, defeating the wrapper's "compile-time sugar" property (DD-012).
- **Copy inherited keys into the lifted slot on entry and back on exit:** Doubles storage and bookkeeping; copy-back-on-exit conflicts with mid-state writes that need to be visible to siblings outside the compound. Rewriting reads and writes to their authoritative locations avoids the copy entirely.

## 019 — `defineMode` discriminates active vs. passive at the type level

**Date:** 2026-05-20

**Rule:** `ModeConfig` is a discriminated union of `ActiveModeConfig` (`input` + `behavior` + `routes`, no `on`) and `PassiveModeConfig` (`on`, no `behavior` / `routes` / `input`). Declaring both shapes on a single `defineMode` call is a compile error.

**Rationale:** A leaf that both invokes an actor and handles events at the same time is the confused state where DD-011 (side effects in the actor, not in transitions) and DD-002 (states are agent modes) drift apart — half the behavior is in `behavior`, half in `on` handlers, and the mode-as-a-unit becomes hard to read. If a state genuinely needs both (e.g. perform work, then accept user input), it should be modeled as a compound: an active leaf for the work, a passive sibling for the listening. The type-level rejection forces the modeling choice to be explicit instead of silently merged.

**Rejected alternatives:**
- **Allow both shapes on one leaf:** Re-creates the original `setup({ actors })` pattern where a state's behavior is partially in its invoke and partially in its event handlers — exactly the boilerplate the wrapper exists to eliminate.

**Rejected alternatives:**
- **Status quo (raw XState).** Forces the DD-008-011 shape to be hand-written and review-policed. Every new mode pays the same boilerplate; every `onDone` entry casts `event.output` to a payload type. The contract is real but invisible to the compiler.
- **Replace XState entirely.** XState's runtime (inspector, actor model, hierarchical states) is not the problem — the *authoring surface* is. A custom runtime would re-create those concerns from scratch with no offsetting benefit.
- **Lift only the actor naming (DD-008) into a helper, leave `routes` raw.** Captures one decision out of four. The `event.output` cast survives at every routing site; the contract between `behavior`'s return and the `onDone` guard array stays untyped. Partial solutions in this area have negative ROI — the value comes from closing all four loops at once.

## 020 — Wrapper vocabulary: `modes`, not `states`

**Date:** 2026-05-22

**Rule:** The wrapper's user-facing collection of slots inside a compound or agent is named `modes`. Every surface type (`AgentConfig.modes`, `CompoundModeConfig.modes`, `ModesMap<TContext, TEvents>`, the `TModes` generic on `defineAgent` / `defineCompoundMode`) uses "mode" exclusively. `states` survives only at the XState boundary the wrapper does not own — the `setup().createMachine({ states: ... })` call inside `compile.ts`, `snapshot.value` paths exposed by `createActor`, and other XState-owned surfaces the wrapper explicitly forwards through.

**Rationale:** Ties spec 004 §Verification 5 ("No XState API leakage in user code") to DD-002 ("each state is an agent mode"). The original `states:` field name reintroduced XState's vocabulary at every call site, undermining the mental model the wrapper is supposed to establish: the user authors *modes* (units of agent behavior), and the compiler translates them into XState *states*. Mixing the two terms at the authoring surface forced every reader to context-switch between the wrapper's contract and XState's own. The wrapper still emits `states:` on the XState side because that is XState's API, not the wrapper's — the asymmetry is the point.

**Rejected alternatives:**
- **Keep `states:` for terminological familiarity with XState users.** Familiarity is the cost, not the benefit: spec 004 §Verification 5 exists specifically to make Zoe (and future consumers) readable without prior XState knowledge. DD-002 already commits to "mode" as the authoring noun; leaving `states:` in the type contract contradicts that commitment at the most visible point of the API.
- **Expose both `modes:` and `states:` as aliases.** Doubles the surface, invites half-migrations where one file says `modes:` and a sibling says `states:`, and leaves the XState term reachable from user code — the exact leak §Verification 5 forbids.

## 021 — `TContext` is JSON-serializable by type contract

**Date:** 2026-05-22

**Rule:** The user-declared `TContext` (and every compound's `local`) is constrained to `JsonCompatible<T>` at the field position on `AgentConfig.context` and `CompoundContext.local`. Recursively, this admits `string | number | boolean | null | undefined`, readonly arrays and plain objects composed from those, while substituting `never` at any `Date`, `Map`, `Set`, `bigint`, `symbol`, function, or class-with-methods position — which collapses the user's literal into a compile error at exactly the offending field. `TPayload` (returned by `behavior`) stays unconstrained: payloads do not flow into context unless `routes.*.assign` writes them there, and the assign return type is itself a `Partial<TContext>` so the constraint reasserts at the only point where it matters.

**Rationale:** Spec 004 leaves `TContext` open (`AgentConfig<TContext, ...>`), so Zoe's `{ messages: Message[] }` is JSON-safe by accident, not by contract. The moment a future mode adds `lastSeen: Date`, `pendingCalls: Map<string, Promise>`, or a class with methods, the wrapper would silently produce a snapshot that either drops the field (`Map` → `{}`), produces a lossy string (`Date` → ISO string that does not parse back as a `Date`), or throws (cyclic). Persistence-backed flows — the whole reason the wrapper exists as an orchestration layer — would fail at the first checkpoint with a runtime error nobody could prevent at authoring time. The constraint moves the failure to the line that declares the bad field. Applying the constraint at the field position rather than as a generic upper bound (`<TContext extends JsonCompatible<TContext>>`) avoids the recursive-constraint cycle TypeScript rejects, while still rejecting the offending literal at the call site.

**Rejected alternatives:**
- **Runtime guard at `defineAgent`.** Catches the error at construction time, not authoring time. The IDE shows nothing red; the failure surfaces only when the agent runs — and even then, only if the offending mode actually transitions. The contract is invisible to review and to the type checker, defeating the wrapper's authorship-time-correctness premise (spec 004 §Goal).
- **Constrain `TPayload` too.** Payloads are the bridge from `behavior` to `assign`. A payload can carry an `Error`, a parsed Zod result, or a transient handle that the assigner reads but never writes to context. Constraining the payload itself would prevent useful idioms while adding no safety — the only path from payload to persisted context goes through `assign`, whose return type already enforces `Partial<TContext>`.
- **`extends JsonCompatible<TContext>` as a generic bound.** TypeScript treats this as a recursive constraint cycle (the constraint mentions the parameter under constraint) and reports errors at the use site that point to the wrapper, not the user's field. The field-position pattern threads the same recursion through a positional substitution where the offending sub-type is the one rejected, surfacing the error precisely.

## 022 — `deps` is provided at agent construction time and shallow-frozen

**Date:** 2026-05-22

**Rule:** `defineAgent` takes an optional `deps: TDeps` field (default `{}`). When the wrapper compiles the agent, it calls `Object.freeze` on the deps container exactly once, in place, then threads the *same frozen reference* into every user callback envelope (`input`, `behavior`, `routes.*.assign`, `routes.*.guard`, `EventTransition.guard`). The freeze is shallow: top-level reassignment throws under strict mode, but mutating fields inside a dep value is allowed by design. Deps live alongside, not inside, the machine's `context` — they never appear in `JSON.stringify(snapshot.context)` and never participate in the `JsonCompatible` constraint.

**Rationale:** Modes that need a DB driver, an LLM client, or a logger must not import them as module globals — that couples each mode file to a specific runtime instance, forbids running two agents side-by-side with different backends, and makes test isolation require module-level mocking. The deps container makes the dependency explicit at the boundary, typed (no `any` escape), and immutable from the consumer's vantage (top-level reassignment is the failure mode the freeze prevents). Construction-time injection — rather than per-call or per-actor injection — preserves the wrapper's "one machine, one config" mental model from spec 004 and matches the lifetime of every other agent-level concern (`id`, `initial`, `context`, `modes`). Shallow freeze rather than deep freeze keeps the door open for legitimate stateful deps (a cache, a counter, a connection pool with internal bookkeeping) without exposing the wrapper to the cost or surprise of deep-freezing arbitrary consumer objects.

**Rejected alternatives:**
- **Deep freeze.** Would forbid stateful deps (caches, pools, accumulators) that are unambiguously the consumer's intent. Also expensive on arbitrary nested structures and surprising when third-party objects (a logger instance with internal buffers) start throwing on internal writes. The deps container's job is to prevent the consumer from swapping `deps.db = ...` mid-run — not to police the internals of objects the consumer owns.
- **Per-invocation deps (factory or actor input).** Threading deps through every `invoke` per state mode reintroduces the boilerplate spec 004 exists to remove. Each mode would repeat the same forwarding plumbing, and the deps would be observable to XState's serialized snapshot — defeating both ergonomics and the DD-021 contract.
- **Deps as part of `context`.** Forces the consumer's resources into the JSON-serialization contract from DD-021 (a DB driver is not `JsonCompatible`), and worse, makes the resources part of the machine's persisted state — so resuming from a snapshot would deserialize a stale handle to a closed connection. Deps and context have different lifetimes and different durability semantics; collapsing them would corrupt both.

## 023 — `when` predicates stay deps-free

**Date:** 2026-05-22

**Rule:** The `when` field on `routes.*` entries keeps its bare-value signature `(payload: TPayload) => boolean`. It does **not** receive an envelope `{ payload, deps }`. The deps thread reaches `input`, `behavior`, `assign`, and `EventTransition.guard` — but `when` stays a pure predicate over the payload.

**Rationale:** `when` exists to dispatch on the shape of the payload that just came back from `behavior` — that is a *value* decision, not a *world* decision. Routes are ordered, predicates are evaluated top-down, and a payload's shape is the entire universe of inputs that should determine which branch fires. Threading deps into `when` would invite asking the database from inside a route predicate, which is exactly the latency-and-correctness hazard XState guards exist to prevent (guards must be synchronous and side-effect-free). The bare signature also makes the type-level test that a guard handler can ignore `deps` (DD-022) and the predicate handler cannot accept one (this DD) cleanly separable.

**Rejected alternatives:**
- **Switch `when` to envelope shape for consistency with `assign` and `guard`.** Consistency at the syntax level masks an inconsistency in purpose: `assign` writes context and `guard` decides whether an event applies — both legitimately depend on world state. `when` only inspects the payload; widening it just because the neighboring fields take envelopes invites the latency-and-side-effect hazard above.
- **Allow both signatures (bare and envelope) by overload.** Doubles the surface, makes the type-level "you cannot ask for deps in a `when`" test impossible to write, and gives no benefit over the consumer manually destructuring an outer closure if they really do need deps in dispatch (which they shouldn't).

## 024 — `Mode` is the leaf; `CompoundMode` is the composite

**Date:** 2026-05-22

**Rule:** The two carrier types are named for what they *are*, not for what they wrap. A leaf — a single agent mode with `behavior`/`routes` or `on` handlers — is `Mode<TContext, TEvents, TPayload, TDeps>`, constructed via `defineMode(...)`. A node that nests other modes is `CompoundMode<TParentContext, TEvents, TDeps>`, constructed via `defineCompoundMode(...)`. The leaf is the base of the vocabulary because every agent has at least one leaf — there is no agent composed exclusively of compounds — and "mode" without qualifier should mean the unit the user reaches for first. The composite gets the longer name because the composite is the special case.

**Rationale:** The previous vocabulary (`LeafMode` for leaves, `Mode` for compounds) inverted the bias: every author types `defineLeafMode(...)` dozens of times per agent and `defineMode(...)` at most a handful, so the constructor for the common case carried the qualifier and the rare case got the bare noun. The asymmetry crept into spec prose (`Mode` had to be repeatedly disambiguated as "compound" because the bare word meant the composite, not the unit). Renaming flips both surfaces: the constructor a Zoe author calls most often is the short one (`defineMode`), and the unqualified noun in prose ("a Mode") refers to the unit, matching DD-002 ("each state is an agent mode"). The compound's full name (`CompoundMode`) is now self-describing, removing the read-by-context cost. No semantic change: the type contracts, the split-brand contravariance on `TDeps` (DD-022), and the discriminated-union check (DD-019) are untouched; only the names move.

**Rejected alternatives:**
- **Keep the pre-rename vocabulary (`LeafMode` / `Mode`).** Familiarity with the existing files is the only argument. It is paid for by every future reader of every future spec, where "Mode" still means "the rare, composite kind" — exactly the lexical drag this rename removes. The cost of one mechanical rename PR is a one-time, finite tax; the cost of leaving the names misaligned recurs every time the wrapper is read.
- **Rename only the constructor (`defineLeafMode` → `defineMode`), keep the type names.** The constructor and its return type would then disagree (`defineMode` returns a `LeafMode`), reintroducing the same disambiguation cost at every signature.
- **`SimpleMode` / `NestedMode`, or `BaseMode` / `GroupMode`, etc.** Every alternative pair either has the same length-asymmetry problem in reverse or fails to convey what the composite actually does (nest other modes). `Mode` / `CompoundMode` reads the same way the runtime works: a Mode does one thing; a CompoundMode contains other Modes.

## 025 — `CompoundMode` owns `routes`, not `onDone`

**Date:** 2026-05-27

**Rule:** `CompoundModeConfig` exposes the same four-bucket `routes` map that `Mode` exposes, plus an optional `output?: ({ context, deps }) => TPayload` callback. The single `onDone: RouteTarget` field is removed. The compound's bubble outcome is whichever bucket of the exiting child contained `target: END`; `output` produces the payload that `routes.*.when` callbacks discriminate on. `routes.retry` is constrained to `readonly []` (shape symmetry with `Mode`; the slot never fires because `RetryEntry` has no `target` per DD-014). Passive `on[event].target = END` defaults to bubbling `achieved`.

**Rationale:** `Mode` and `CompoundMode` are already two faces of the same concept (DD-002, DD-024) — the constructors mirror each other, the brands mirror each other, the `modes` slot accepts both interchangeably. The single `onDone: RouteTarget` was the last asymmetry: a compound could exit to exactly one destination regardless of which outcome its child produced. The original socratic flow worked around this by encoding three outcomes inside `evaluating`'s payload and dispatching them from `routes.achieved` inside the leaf (`examples/zoe/src/states/socratic.evaluating.ts:55-67`) — pushing routing logic that conceptually belongs at the compound boundary down into one of its children. After this DD the compound's exit shape is symmetric to the leaf's; `socratic.evaluating` returns genuine outcomes and the compound dispatches on them directly.

Lowering: for every compound whose subtree references `target: END`, the wrapper computes the set of outcome buckets the END appears in and injects one `{ type: "final", output: ({ context }) => ({ outcome: "<key>", payload: cfg.output?.({ context, deps }) ?? undefined }) }` substate per bucket — `$end_achieved`, `$end_abandoned`, `$end_error`. The compound emits a single `onDone: [...]` array, one entry per declared `routes[outcome][i]`, guarded on `event.output.outcome` (and the optional `when(payload)`). Smoke-tested against `xstate@5.31.1` before sign-off: distinct finals' `output` values reach the parent's guarded `onDone[]` correctly, and `output` sees context after the entering transition's `assign` has run.

**Rejected alternatives:**
- **Keep `onDone: RouteTarget` and parameterize `END` (e.g. `END({ outcome })`).** Pushes the outcome decision *into* the leaf's `target` expression rather than reading it off the bucket the leaf already chose. The bucket name (`achieved` / `abandoned` / `error`) is the outcome; making the leaf restate it is redundant and creates a second source of truth that can disagree with the bucket the entry sits in.
- **Allow children to bubble `retry` (give `RetryEntry` a `target` so `target: END` works in `routes.retry`).** Violates DD-014 (retry is structurally a self-loop on the same leaf). Compound retry — restarting the compound's children from `initial` — has no current use case, and inventing one would collapse retry's identity into something `achieved` already does.
- **Single global `$end` final substate at the compound, discriminate via a payload field.** Reintroduces the same payload-encoded dispatch the spec exists to eliminate, just moved one level up. The whole point is that the *bucket the child END'd from* is the wire-level signal — no payload encoding needed for the outcome itself.

**Supersedes:** Nothing. DD-014 stays in force (retry as self-loop, no target). DD-017 (END is injected per-compound, only when referenced) generalizes: instead of one `$end` per compound, the wrapper injects one final substate per outcome bucket that the subtree actually references. The "minimal emitted machine" property is preserved per-bucket.

## 026 — Single-substate one-shot modes are leaves, not compounds

**Date:** 2026-05-28

**Rule:** A mode whose only substate does not handle `MESSAGE` is expressed as a leaf `Mode`, not as a single-substate `CompoundMode`. The leaf routes its outcome buckets directly to root siblings. Applies to `greetings` and `improvising`. `socratic` stays a compound because it has genuine multi-turn substates (`teaching` / `listening` / `evaluating`).

**Rationale:** The compound wrapper existed only so the inner leaf could use `target: END` — the sole way to exit a compound. But a *top-level* leaf's siblings already **are** the root modes, so it can write `target: "classifying"` directly; `classifying` itself routes to sibling modes this way. For `greetings`/`improvising` the wrapper bought nothing and cost three things: an extra state-value level (`{ greetings: "thinking" }`), an extra file (`*.thinking.ts`), and an actor-name hop (`greetingsThinkingNode`). Flattening removes all three with no behavioral change to the conversation flow.

**Side fix (`improvising` error path):** Pre-flatten, the child routed `routes.error.target = END` while the compound omitted `routes.error`. Per DD-017 / `injectEnd.ts`, that re-throws above the compound and **drops the entry's `assign`** — so the `console.error` never ran and the agent crashed on an LLM transport error. Both spec 003 §`improvising` and the code comment claimed "log + recover to classifying", which was never the compiled behavior. As a root leaf, `improvising` now routes `error → "classifying"` (a sibling), so the documented recover-and-log behavior is finally what runs.

**Supersedes:** the "one-shot modes use thinking → done (final)" decision in DD-003 (its multi-turn thinking/listening guidance for `socratic` stays in force). DD-008 (actor name mirrors path) is unchanged and auto-applies — shorter paths yield `greetingsNode` / `improvisingNode`. DD-009 (one state file per mode) is unchanged in spirit; `greetings`/`improvising` are now a single `<mode>.ts` instead of `<mode>.thinking.ts`.

## 027 — `startAgent` is the runtime boundary; snapshot restore beats entry-reset

**Date:** 2026-06-02

**Rule:** Atlas owns the actor lifecycle. The single supported boot point is `startAgent(machine, { snapshot?, inspect? })`, exported from `@eduardorenani/atlasjs`. The returned `AgentActor<TContext, TEvents>` exposes only `send`, `stop`, and `getSnapshot` — every other surface XState's `Actor` carries (`subscribe`, `getPersistedSnapshot`, the raw inspect stream, the actor system) stays behind the brand. Hosts that boot an Atlas agent import only from `@eduardorenani/atlasjs`. Importing anything from `xstate` outside `packages/atlas/src/` is a wrapper bug, not an escape hatch — and inside the wrapper only `startAgent.ts` is allowed to import `createActor`.

`AgentSnapshot<TContext>` is the persistence carrier: opaque to the host, JSON-safe by construction (XState's `getPersistedSnapshot()` round-trips through `JSON.stringify` / `JSON.parse`), branded contravariantly on `TContext` so a snapshot from agent A is unassignable to `startAgent` for agent B at the type level. The `atlasVersion` stamp lets storage detect cross-version drift; Atlas does not ship migration helpers.

**Rehydration rule (the load-bearing change):** when `startAgent` is called with `{ snapshot }`, the persisted slot for every compound `local` survives the compound's `entry` reset. DD-018's reset-on-re-entry semantics stays in force for **intra-turn** dynamics (parent transitions away, then back, still resets the slot); the snapshot path is the one exception. The implementation hook is XState v5's `createActor(machine, { snapshot })`, which does not re-execute `entry` actions on the restored state — so routing the persisted snapshot through that constructor is sufficient, and `contextLift.ts` needs no special-case work.

**Rationale:** Pre-009, the canonical multi-turn host pattern (rebuild the machine per turn from a persisted snapshot) silently violated DD-018's docstring promise that compound `local` survives persistence. `contextLift.ts` emitted `entry` actions that reset the slot to `initialLocal` whenever the compound was entered, and a fresh actor with `createActor(machine).start()` re-enters every active compound on boot — wiping the persisted slot before user code could observe it. The fix is structural: the host must thread the snapshot into `createActor`'s constructor (which skips `entry` on restore), and to enforce that uniformly Atlas owns the actor boot. Construction-time `inspect` (instead of runtime `subscribe`) matches the deps-freezing model from DD-022: observation is wired at boot, and the inspect callback receives Atlas-vocabulary events (`{ type: "transition", from, to, context }`) — `from` / `to` are dot-joined mode paths computed by an internal `formatModePath`, so user code never walks XState's nested `snapshot.value` shape.

The brand on `AgentSnapshot<TContext>` carries `TContext` phantomly so the type checker refuses cross-context restores. The host treats the value as opaque; storage is one `JSON.stringify` / `JSON.parse` round-trip with a runtime cast at the trust boundary.

**Rejected alternatives:**
- **Keep `createActor` as the host-facing boot point and document the snapshot pattern.** Leaves the XState surface — `subscribe`, `getPersistedSnapshot`, the raw `@xstate.snapshot` inspect event, the `actorRef`-filter dance — exposed at every host call site. The mode-path string formatting that spec 009's `formatModePath` does once would have to be reinvented at every observation seam. Worse, the snapshot bug is host-implementable but only correct *if* the host remembers to route the snapshot through the constructor — and nothing forces them to. The whole point of owning the boot is to make the correct path the only path.
- **Special-case `contextLift.ts` to detect a restored snapshot and skip the `entry` reset.** Reinvents what XState v5's `createActor({ snapshot })` already does. Doubles the surface area for snapshot-aware behavior to live in (now both the wrapper boot AND the compiled entry action need to agree on what "restored" means), and the divergence between intra-turn re-entry and snapshot restore would no longer be expressible at a single hook.
- **Expose `getPersistedSnapshot` directly on `AgentActor`.** Forces hosts to know about XState's internal snapshot shape and bypasses the brand-based cross-context check. The `AgentSnapshot` wrapper costs one allocation per `getSnapshot()` call and buys both type-level safety and a place to put the version stamp.
- **Runtime `actor.subscribe` for multi-listener observation.** Out of scope for Phase 1. The construction-time `inspect` primitive is sufficient for the readiness gates hosts need; if a future host genuinely needs runtime listener add/remove, that's a follow-up spec, not a place to bleed XState's full subscriber model into the public API.

**Supersedes:** DD-018's docstring promise that compound `local` survives persistence is now the *contract* (spec 009 §Persistence Contract), not just an aspiration. The slot-reset behavior in `contextLift.ts` is unchanged; what changed is the boot point that decides whether `entry` runs at all on a given state.

## 028 — `onError` is the host-side escape channel

**Date:** 2026-06-02

**Rule:** `startAgent` accepts an optional `onError(info: AgentErrorInfo<TContext>)` callback that fires precisely when a rejection from a leaf's `behavior` escapes the machine's declarative recovery. "Escape" is defined operationally by XState v5's `actor.subscribe({ error })`: it fires when `routes.error` is absent, no entry's `when` matches, or a matched entry targets `RE_THROW`. Intra-machine recovery via `routes.error: { target: <sibling> }` is unchanged — the rejection is consumed silently, `onError` does NOT fire, and the host observes only the recovery transition through `inspect`. `onError` is construction-time only (same invariant as `inspect`, per DD-027) and additive: when omitted, the wrapper makes no `subscribe` call and XState's default propagation is preserved.

`AgentErrorInfo<TContext>` carries: `error: unknown` (raw rejection), `modePath: string` (formatted by the same `formatModePath` `inspect` uses), `context: TContext` (post-`assign` root context), and `snapshot: AgentSnapshot<TContext>` (captured synchronously inside the error subscriber via `xstateActor.getPersistedSnapshot()`, before the actor's terminal state hides the failed leaf). Hosts re-enter the failed leaf by feeding `info.snapshot` to a fresh `startAgent({ snapshot })`; hosts that want fire-and-log persist the *prior* turn's snapshot instead.

**Rationale:** Pre-010, hosts that called the LLM transport from `behavior` and didn't declare `routes.error` had no way to log the rejection with host-level context (request id, trace id, user id) — the rejection became an uncaught process-level error, and the canonical readiness-gate pattern (Promise resolved on `inspect → transition → listening`) never settled because no transition fired. The fix is to forward XState's existing actor-level error observer at the Atlas surface, in the same construction-time shape DD-027 established for `inspect`. The two callbacks compose: `inspect` observes machine transitions, `onError` is the result channel for escapes. Hosts compose readiness gates that settle on either channel and decide per-call whether to re-enter the failed leaf or fall back to a prior snapshot.

The four-outcome `Routes` contract (DD-013) is preserved: `error` is still the machine-level recovery slot; `onError` is the host-level escape channel. They never overlap — XState's subscribe.error fires only when intra-machine recovery did NOT consume the rejection.

**Rejected alternatives:**
- **Add an `error` variant to `AgentInspectionEvent`** (single-callback design). Forces every existing `inspect` handler to `switch (e.type)` even when it only cares about transitions, and conflates observation-of-transitions with a result channel that gates host-level control flow. Two callbacks compose without conflict.
- **Always fire `onError` on every rejection, even when `routes.error` catches.** Would require intercepting at the actor logic level and double-firing for handled errors — directly contradicts DD-013's contract that `routes.error` IS the machine-level recovery slot. Hosts that want both intra-machine recovery AND external observation log inside `routes.error.assign` via `deps.logger`.
- **Always subscribe; let the host filter by checking for `onError` itself.** Costs a permanent subscriber for hosts that don't opt in. The "no `onError` = no subscribe" invariant is the additive guarantee — hosts that ship against alpha.3 see zero behavioral change at alpha.4.
- **Expose `actor.subscribe` directly on `AgentActor`.** Re-introduces XState's runtime API at the host surface, which DD-027 explicitly hid. The construction-time shape matches `inspect` and `deps` (DD-022) — observation is wired at boot.
- **Synchronous `throw` from `onError` to keep the rejection escaping.** XState's subscribe.error already handles the actor's terminal state; the host's `onError` is observation, not control flow. Re-throwing from the callback would re-pollute the process boundary with the same rejection the host just observed.

**Supersedes:** Spec 009 §Clarifications #1 deferred `enter` / `exit` / `error` event kinds on `AgentInspectionEvent`. The `error` kind lands here, but as a separate callback rather than a union variant — for the same reason given in Clarifications #1 above.
