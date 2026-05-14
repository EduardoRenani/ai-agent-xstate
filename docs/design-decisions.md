# Design Decisions

## 001 — No cross-boundary sub-state targeting

**Date:** 2026-05-14

**Rule:** Transitions must never target a child sub-state of another compound state. Always target the parent and let it route internally via its `initial` state.

**Problem:** If `greetings` targets `#agent.improvise.thinking` directly, it knows `improvise`'s internal structure. Reorganizing `improvise`'s children silently breaks `greetings`.

**Solution:** `greetings` transitions to `improvise` (parent) and raises `PARTIALLY_RESPONDED`. The event is queued and delivered after `improvise.listening` is entered. `listening` handles the event and transitions to `thinking`, which inspects context to continue processing. No state knows the internal structure of another.

**Rejected alternatives:**
- **Absolute ID targeting** (`#agent.improvise.thinking`): couples the source to the target's internal structure.
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

**Decision for `improvise`:** Uses thinking/listening because conversational responses should not be interrupted by accidental keystrokes.

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

**Principle:** Events represent facts — something that happened. They are named in past tense or as factual observations (`MESSAGE`, `PARTIALLY_RESPONDED`), never as imperative commands (`CONTINUE`, `PROCESS`, `START`). The machine's behavior is determined by which events it accepts and how it reacts, not by being told what to do.

**Naming test:** If an event name reads as an order to the machine ("do this"), it is wrong. It should read as a report ("this happened"). `PARTIALLY_RESPONDED` is a fact — the agent partially responded. `CONTINUE` is a command — it tells the machine what to do next.

## 007 — Flag + guard is an antipattern for control flow

**Date:** 2026-05-14

**Rule:** Do not use booleans in context combined with `always` guards to route transitions between states.

**Problem:** A flag (e.g. `unprocessedMessage: boolean`) set by one state and read by an `always` guard in another encodes control flow in data. The causal link between states is invisible in the state chart — it only appears by tracing context mutations. Debugging requires reading the code instead of reading the chart.

**Correct alternative:** Use `raise()` to emit an event. The receiving state handles the event through a normal `on` transition. The causal link is explicit and visible in the state chart.

**Example:** `greetings` raises `PARTIALLY_RESPONDED` on completion. `improvise.listening` handles it by transitioning to `thinking`. No flag needed — the event is the signal, and context (messages) provides the data.

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

**Rule:** Each state that has an invoked actor gets its own file containing all artifacts coupled to that state: system prompt, tool definitions, tool registry, and actor definition. The file is named `<outerstate>.<innerstate>.state.ts` for nested states, or `<state>.state.ts` for top-level states.

**Examples:**
- `greetings` → `src/states/greetings.state.ts`
- `improvise.thinking` → `src/states/improvise.thinking.state.ts`

**What a state file exports:**
- The actor (e.g. `greetingsNode`)
- Optionally, the tool definitions if they need to be referenced elsewhere (e.g. for testing)

System prompts, tool registries, and other internal constants are private to the file — they are implementation details of the actor.

**Rationale:** XState's `setup()` forces actors to be declared separately from the states that invoke them (decision 008). As the agent grows, keeping all actors and their prompts/tools in `machine.ts` makes it unreadable. Separating into state files preserves the conceptual coupling (the actor *is* what the state does) while keeping `machine.ts` focused on the machine structure: states, transitions, and context.

**What stays in `machine.ts`:**
- The machine definition (`setup()` + `createMachine()`)
- Structural actions (e.g. `appendUserMessage`)
- Type definitions (`LLMInput`, context type)
- Imports of actors from state files and their registration in `setup().actors`

**Supersedes:** Decision 005's clause "module-level constant in `machine.ts`" is superseded — prompts now live in the state file, not in `machine.ts`. The principle remains (prompts are per-state, not in context), only the location changes.
