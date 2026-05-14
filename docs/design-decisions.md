# Design Decisions

## 001 — No cross-boundary sub-state targeting

**Date:** 2026-05-14

**Rule:** Transitions must never target a child sub-state of another compound state. Always target the parent and let it route internally via its `initial` state.

**Problem:** If `greetings` targets `#agent.improvise.thinking` directly, it knows `improvise`'s internal structure. Reorganizing `improvise`'s children silently breaks `greetings`.

**Solution:** `greetings` is a transient state (entry action + `always` transition to `improvise`). It does not carry the user's message into context — its only job is to greet. `improvise` starts at `listening` (its natural initial state), and the user's first question arrives as a normal `MESSAGE` event. This eliminates the need for cross-boundary targeting entirely.

**Rejected alternatives:**
- **Absolute ID targeting** (`#agent.improvise.thinking`): couples the source to the target's internal structure.
- **`always` guard in child state**: moves the coupling to the target — the child carries routing logic that only exists to serve the source. A state should not carry guards that compensate for another state's transition intent.

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
