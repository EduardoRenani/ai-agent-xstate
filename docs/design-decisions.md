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

**Decision for one-shot modes (`greetings`, `improvising`):** These modes use thinking → done (final) without an internal listening state. The root `listening` is a sibling state, not a parent — events do not reach the mode's invoke states. Protection against interruption is preserved by XState's sibling isolation: when the machine is in `improvising.thinking`, the root `listening` is inactive and `MESSAGE` events are not handled.

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

**Rule:** Agent code expresses its modes through the `atlas` library (`defineLeafMode`, `defineMode`, `defineAgent`) — not through raw XState `setup()` / `createMachine()` / `fromPromise` / `assign` / `onDone` arrays. Importing from `xstate` inside agent source is a wrapper bug, not an escape hatch.

**Rationale:** Decisions 008-011 codify a recurring shape: each state owns an invoked actor (DD-008), the actor and its prompt live together in a state file (DD-009), the transition after completion is decided by an ordered guard array on `onDone` (DD-010), and side effects are performed inside the actor (DD-011). Expressed in raw XState, that shape forces four separate hand-written pieces per mode — actor registration in `setup({ actors })`, the invoke block, the `onDone` guard array reading `event.output`, and the manual `assign` for context merging — held together by naming convention rather than by the type system. As the agent grows, the boilerplate scales linearly with the mode count and the `event.output` access stays untyped at every site.

The wrapper takes the shape that DD-008-011 already mandate and makes it the only way to express a mode. `defineLeafMode` returns a single object holding `input`, `behavior`, and `routes` (a four-key map: `achieved` / `retry` / `abandoned` / `error`); the wrapper compiles this to the equivalent XState configuration. Actor names are derived from the state path (DD-008 becomes an invariant enforced by the compiler, not a convention enforced by review). The `routes` map closes over a typed `payload`, so `event.output` casts disappear at every call site. Side effects continue to live inside `behavior` (DD-011 unchanged).

The output of `defineAgent` is a standard XState machine, so `createActor`, the inspector API, and existing tests keep working unchanged. The library is pure compile-time sugar — at runtime there is no extra layer.

**Scope:** Spec 004 defines the contract; it migrates `classifying`, `greetings.thinking`, `improvising.thinking`, and the root `listening` to the wrapper, and defers the `socratic` compound to a follow-up on top of spec 003 (the existing sideways-jump retry does not map cleanly to the wrapper's self-loop retry). Until that follow-up lands, `socratic` stays in raw XState — but as deferred-migration code, not as a permitted pattern.

**Supersedes:** Nothing. DD-008 through DD-011 stay in force; the wrapper is how they get expressed, not what they say. DD-009's file-naming convention is restated by the wrapper (`<state>.ts` under `examples/zoe/src/states/`); the `.mode.ts` suffix used by the current code is dropped only for migrated modes — deferred mode files keep their existing names until the follow-up spec.

**Rejected alternatives:**
- **Status quo (raw XState).** Forces the DD-008-011 shape to be hand-written and review-policed. Every new mode pays the same boilerplate; every `onDone` entry casts `event.output` to a payload type. The contract is real but invisible to the compiler.
- **Replace XState entirely.** XState's runtime (inspector, actor model, hierarchical states) is not the problem — the *authoring surface* is. A custom runtime would re-create those concerns from scratch with no offsetting benefit.
- **Lift only the actor naming (DD-008) into a helper, leave `routes` raw.** Captures one decision out of four. The `event.output` cast survives at every routing site; the contract between `behavior`'s return and the `onDone` guard array stays untyped. Partial solutions in this area have negative ROI — the value comes from closing all four loops at once.
