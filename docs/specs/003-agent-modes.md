# 003 — Specialized Agent Modes

## Goal

Introduce an intent classification step and specialized agent modes. Each mode has a clear goal and a formal evaluation interface that determines whether to continue, succeed, or abandon. Modes may be compound states with their own submachine when multi-step behavior is needed, or simple states when a single invocation suffices. Start with three modes: `greetings`, `socratic`, and `improvising`.

## State Diagram

```
listening (initial, accepts MESSAGE)
  on MESSAGE → classifying (with appendUserMessage)

classifying
  invoke: classifyingNode
  onDone [payload.intent=greetings]  → greetings
  onDone [payload.intent=socratic]   → socratic
  onDone [payload.intent=none]       → listening
  onDone [default]                   → improvising

greetings (compound):
├── thinking (initial)
│   invoke: greetingsThinkingNode
│   onDone → done (assign payload.messages)
│
└── done (final)

  onDone → classifying

socratic (compound):
├── teaching (initial)
│   invoke: socraticTeachingNode
│   onDone → listening (assign payload.messages)
│
├── listening
│   on MESSAGE → evaluating (with appendUserMessage)
│
├── evaluating
│   invoke: socraticEvaluatingNode
│   onDone [outcome=achieved]  → done
│   onDone [outcome=abandoned] → done
│   onDone [outcome=retry]     → teaching
│
└── done (final)

  onDone → classifying

improvising (compound):
├── thinking (initial)
│   invoke: improvisingThinkingNode
│   onDone → done (assign payload.messages)
│   onError → done (print error)
│
└── done (final)

  onDone → classifying
```

## Key Design Points

### Unified `listening` at root level

The root `listening` state replaces the previous `idle`. It accepts `MESSAGE` at any point in the agent's lifecycle — both the very first message and all messages after a mode completes. There is no separate "uninitialized" state.

### Classification as the routing hub

Every message flows through `classifying`. The classifier examines the full conversation history (not just the latest message) and returns an intent. This is the single point of routing — no mode decides what comes next.

After any mode completes (via its final state), control returns to `classifying`, not to `listening`. This means every mode exit triggers a classification step. The classifier determines the next step: whether there is pending content to address (e.g., a question embedded in a greeting), a new intent to route, or nothing left to do.

When the classifier determines there is nothing left to address, it returns `{ outcome: "achieved", payload: { intent: "none" } }`. The guard routes back to `listening` without entering any mode.

**First message detection:** The classifier checks `context.messages` internally. If only one user message and no assistant messages → returns `{ intent: "greetings" }` without calling the LLM. This is the only deterministic short-circuit.

**LLM classification:** For all other cases, the classifier calls the LLM with the full conversation history. The LLM determines whether there is unaddressed user content and classifies intent accordingly. This includes the common case after a mode completes normally (LLM returns `"none"`) and edge cases like socratic abandonment where the user's message contained both an exit request and a new question (LLM returns the appropriate intent for the new question).

A deterministic "no pending intent" check (e.g., "last message is from assistant → none") was considered and rejected: it fails when a mode appends a response (e.g., socratic farewell) but the user's message contained unaddressed content. Only the LLM can judge whether the user's intent was fully addressed.

The actor encapsulates both paths (first message, LLM classification). The state just routes on output. No `always` transitions needed.

### `PARTIALLY_RESPONDED` eliminated

The previous architecture used `PARTIALLY_RESPONDED` as a raised event to signal that a greeting partially addressed the user's message. With the new flow, this is unnecessary: `greetings` completes → control goes to `classifying` → the classifier sees the unaddressed content in context and routes to the appropriate mode. The event is removed.

### `greetings` as a mode

`greetings` is a compound state like any other mode, with `thinking` → `done`. The classifier routes to it on first message. After greeting, the mode exits and the classifier handles any follow-up content.

The `greetingsThinkingNode` actor no longer returns `needsFollowUp` — that responsibility moves to the classifier. The actor returns `ModeOutput<{ messages: Message[] }>` with outcome `"achieved"`, same contract as other mode actors.

### Modes have internal `listening` states

Any state that accepts `MESSAGE` is named `listening` — both at root level and inside modes. The root `listening` routes to `classifying`. A mode's internal `listening` continues within the mode. The name describes the behavior (waiting for user input); the hierarchy provides the semantic context.

### Socratic retry loop

`evaluating` owns the *decision*; `teaching` owns the *speech*. The retry path is purely a routing signal — no message is appended to `context.messages` by `evaluating`.

When the user fails the counter-proof:
1. `evaluating` returns `{ outcome: "retry" }`. It does not modify `context.messages` and does not print anything.
2. The machine transitions to `teaching`. The conversation history still ends in the user's incorrect or incomplete answer, preserving the alternating user/assistant turn order the LLM API requires.
3. `teaching` re-explains the concept from a different angle and issues a new counter-proof. Its system prompt instructs the LLM to detect a previous failed attempt in the conversation history and adjust accordingly.
4. The loop repeats until evaluation returns `achieved` or `abandoned`.

No flags or counters — the conversation history drives the LLM's behavior.

### Socratic abandonment

The `socraticEvaluatingNode` actor detects abandonment in the same LLM call that evaluates the user's answer. The system prompt instructs: "evaluate whether the user answered correctly, answered incorrectly, or is requesting to stop/leave." If abandoned, the evaluation returns `{ outcome: "abandoned" }` — no message, no console output. The mode transitions to `done` (final), and the classifier examines the user's last message (which contains the abandonment, possibly with a new request) and routes accordingly.

There is intentionally no explicit farewell turn from `evaluating`. If the user said "para, que horas são?", the classifier routes to `improvising`; if they just said "para", the classifier returns `none` and the agent waits silently. Emitting a farewell from `evaluating` would violate the analytical-only contract and would also create a double-`assistant` turn problem if any state ever ran after it.

### Mode exit via final state

Every mode exits through a `done` state of type `final`. The parent handles `onDone` uniformly — transition to `classifying`. No cross-boundary targeting (DD-001). No need for the parent to inspect the mode's output.

## ModeOutput — Universal Actor Return Type

Every actor returns `ModeOutput<T>`, where `T` is the mode-specific payload:

```ts
type ModeOutput<T = unknown> = {
    outcome: "achieved" | "retry" | "abandoned";
    payload: T;
};
```

- **`achieved`**: the mode's goal has been met. Transition to `done` (final) or the next routing step.
- **`retry`**: the goal is not met, but the mode should try again. Transition to an internal state to continue.
- **`abandoned`**: the user explicitly requested to stop. Transition to `done` (final).

`outcome` is the universal routing signal — guards on `onDone` inspect `event.output.outcome`. `payload` carries mode-specific data (messages, intent, etc.). Every actor returns this type, including simple modes where `outcome` is always `"achieved"`.

`payload` may be `undefined` (i.e., `ModeOutput<undefined>`) when the actor's role is purely analytical — its return drives routing only and contributes no user-facing content. `socraticEvaluatingNode` is the canonical example.

## Classifier Detail

### Actor: `classifyingNode`

Two internal paths, checked in order:

1. **First message:** `context.messages` contains only one user message and no assistant messages → returns `{ intent: "greetings" }`. No LLM call. This is the only deterministic short-circuit.
2. **LLM classification:** calls the LLM with the full conversation history and a classification system prompt. The LLM classifies the current state of the conversation as:
   - `"socratic"` — the user wants to learn or understand something (asks to explain, teach, clarify a concept).
   - `"improvise"` — general question, task, conversation, or anything else.
   - `"none"` — there is no unaddressed user content; the conversation is idle.

- Returns: `ModeOutput<{ intent: "greetings" | "socratic" | "improvise" | "none" }>`. Outcome is always `"achieved"`.
- Does **not** append anything to `context.messages`.
- State file: `src/states/classifying.state.ts`.

### Guards on `onDone`

Ordered guard array — first match wins:
1. `event.output.payload.intent === "greetings"` → `greetings`
2. `event.output.payload.intent === "socratic"` → `socratic`
3. `event.output.payload.intent === "none"` → `listening`
4. No guard (default) → `improvising`

## Mode Details

### `greetings`

- **Goal:** Greet the user and introduce Atlas.
- **Actor:** `greetingsThinkingNode` (renamed from `greetingsNode`).
- **System prompt:** Instructs Atlas to greet in Portuguese, introduce itself briefly. Returns a text response (no JSON — the `needsFollowUp` classification is now the classifier's job).
- **Returns:** `ModeOutput<{ messages: Message[] }>` (outcome always `"achieved"`).
- **`thinking.onDone`:** Assign `payload.messages` to context, transition to `done`.
- **State file:** `src/states/greetings.thinking.state.ts` (renamed from `greetings.state.ts` per DD-009 — now references the inner state path `greetings.thinking`).

### `socratic`

- **Goal:** Teach the user a concept and verify understanding via counter-proof.

#### `socratic.teaching` (initial)

- **Actor:** `socraticTeachingNode`.
- **System prompt:** Instructs the LLM to explain the topic clearly, then end with a counter-proof verification question to test understanding. If the conversation history shows the user previously gave an incorrect or incomplete answer to a counter-proof, re-explain from a different angle and ask a new counter-proof.
- **Returns:** `ModeOutput<{ messages: Message[] }>` (outcome always `"achieved"`).
- **`onDone`:** Assign `payload.messages` to context, transition to `socratic.listening`.
- **State file:** `src/states/socratic.teaching.state.ts`.

#### `socratic.listening`

- No actor — waits for user input.
- On `MESSAGE`: append user message, transition to `socratic.evaluating`.
- No state file needed.

#### `socratic.evaluating`

- **Actor:** `socraticEvaluatingNode`. **Purely analytical** — produces a routing decision only. Emits no user-facing message, does not modify `context.messages`, does not print to console.
- **System prompt:** Instructs the LLM to evaluate the user's answer. Determines one of three outcomes: the user demonstrated understanding (`achieved`), the user's answer is incorrect or incomplete (`retry`), or the user is requesting to stop (`abandoned`). Returns JSON `{ "evaluation": "achieved" | "retry" | "abandoned" }`. No `feedback` field — feedback and re-teaching are the responsibility of `socratic.teaching` on the next iteration.
- **Returns:** `ModeOutput<undefined>` (outcome varies: `"achieved"`, `"retry"`, or `"abandoned"`; `payload` is always `undefined`).
- **`onDone` guards:**
  - `event.output.outcome === "achieved"` → transition to `done`. No assign.
  - `event.output.outcome === "abandoned"` → transition to `done`. No assign.
  - Default (`retry`) → transition to `teaching`. No assign.
- **State file:** `src/states/socratic.evaluating.state.ts`.

#### `socratic.done` (final)

- No actor, no actions.

### `improvising`

- **Goal:** Answer the user's question or perform a task.
- **Actor:** `improvisingThinkingNode` (renamed from `improviseThinkingNode`).
- **Same behavior as current `improvise.thinking`** — calls `chat()` with general-purpose system prompt and tools. The tool loop is internal to the actor (spec 002).
- **Returns:** `ModeOutput<{ messages: Message[] }>` (outcome always `"achieved"`).
- **`thinking.onDone`:** Assign `payload.messages` to context, transition to `done`.
- **`thinking.onError`:** Print error, transition to `done`.
- **State file:** `src/states/improvising.thinking.state.ts` (renamed from `improvise.thinking.state.ts` per DD-008).

## Events

```ts
| { type: "MESSAGE"; text: string }
```

`PARTIALLY_RESPONDED` is removed. Classification handles follow-up routing.

## Context

No changes to context type:

```ts
{
    messages: Message[]
}
```

## File Map

| File | Change |
|---|---|
| `docs/specs/003-agent-modes.md` | New spec (this document) |
| `docs/specs/README.md` | Add 003 to index |
| `src/types.ts` | New — exports `ModeOutput` type |
| `src/machine.ts` | Restructure: remove `idle`, `improvise`. Add `listening`, `classifying`, `greetings`, `socratic`, `improvising` as top-level states. Remove `PARTIALLY_RESPONDED` from events. Register new actors. All actors return `ModeOutput<T>`. |
| `src/states/classifying.state.ts` | New — classifier actor |
| `src/states/greetings.thinking.state.ts` | Renamed from `greetings.state.ts`. Actor returns `Message[]` instead of `{ greeting, needsFollowUp }`. |
| `src/states/socratic.teaching.state.ts` | New — socratic teaching actor |
| `src/states/socratic.evaluating.state.ts` | New — socratic evaluation actor |
| `src/states/improvising.thinking.state.ts` | Renamed from `improvise.thinking.state.ts` (same logic, new name per DD-008) |
| `src/states/greetings.state.ts` | Deleted (replaced by `greetings.thinking.state.ts`) |
| `src/states/improvise.thinking.state.ts` | Deleted (replaced by `improvising.thinking.state.ts`) |
| `src/index.ts` | No changes (uses `snapshot.can()`, agnostic to state names) |
| `src/llm-client.ts` | No changes |
| `test/machine.test.ts` | Rewrite tests for new structure |
| `docs/design-decisions.md` | Update DD-001, DD-003, DD-006, DD-007, DD-009 (principles unchanged; examples updated for new state names, removed `PARTIALLY_RESPONDED` references). |

## Verification

1. `npx vitest` — all tests pass.
2. First message routes to greetings: user sends "oi" → classifier detects first message → greetings mode → greeting printed → classifier → LLM returns `none` → listening.
3. Greeting with follow-up: user sends "oi, me explica recursão" → greetings → classifier → LLM returns `socratic` → socratic.
4. Learning question routes to socratic: user sends "me explica closures" → classifier → socratic → teaches + asks counter-proof → user answers correctly → done → classifier → LLM returns `none` → listening.
5. Socratic retry: user answers incorrectly → evaluator returns `retry` (silently, no message printed) → teaching re-explains from a different angle and issues a new counter-proof → user answers correctly → done.
6. Socratic abandonment: user sends "para com isso, me diz que horas são" during counter-proof → evaluator returns `abandoned` (silently, no farewell printed) → done → classifier → LLM returns `improvise` → improvising answers the question.
7. General question routes to improvising: user sends "que horas são" → classifier → improvising → tool call → response → done → classifier → LLM returns `none` → listening.
8. Socratic retry preserves alternating turns: after `evaluating` returns `retry`, the conversation history still ends with a `user` message — no `assistant`-only turn is injected — so `teaching`'s `chat()` call does not fail with `OpenRouter returned neither content nor tool_calls`.

## Out of Scope

- More than three modes (only `greetings`, `socratic`, and `improvising` for now; `classifying` is extensible).
- Maximum retry limit for socratic verification.
- Socratic tools (socratic uses chat only for now).
- Streaming responses.
- Mode persistence across sessions.
- Dynamic mode registration.
