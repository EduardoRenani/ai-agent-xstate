# 001 — Hello World Agent

## Goal

Minimal XState v5 agent with three linear states to learn the fundamentals before adding complexity.

## Agent Identity

- **Name:** Atlas
- **Role:** General-purpose assistant
- **Tone:** Friendly and direct
- **Language:** Portuguese (Brazil)

The agent must always identify itself as Atlas. It must never use a different name or claim to be a different entity.

## States

```
idle ──MESSAGE──▶ greetings ──onDone──▶ improvise
                  (raises PARTIALLY_RESPONDED only if needsFollowUp)
                                         ├── listening ──MESSAGE──────────────▶ thinking
                                         │             ──PARTIALLY_RESPONDED──▶ thinking
                                         └── thinking ──onDone───────────────▶ listening
```

### `idle` (initial)

- On event `MESSAGE`:
  - Append `{ role: "user", content: event.text }` to `context.messages`.
  - Transition to `greetings`.

### `greetings` (invoke state)

- Invoke: `greetUser` actor — calls `chat(context.messages, GREETINGS_SYSTEM_PROMPT)` and parses the JSON response into `{ greeting: string, needsFollowUp: boolean }`. The LLM sees the user's message and classifies whether it requires follow-up beyond the greeting.
- `onDone`:
  - Print `greeting` to stdout, append `{ role: "assistant", content: greeting }` to `context.messages`.
  - If `needsFollowUp` is `true`: raise `PARTIALLY_RESPONDED`.
  - Transition to `improvise`.
- `onError`: print error to stderr, transition to `improvise`.
- Fallback: if JSON parsing fails, treat the raw response as greeting, `needsFollowUp = false`.
- Does **not** handle `MESSAGE` — the agent is generating its greeting.

### `improvise` (compound state)

#### `improvise.listening` (initial)

- On event `PARTIALLY_RESPONDED`: transition to `improvise.thinking` (no append — user message is already in context).
- On event `MESSAGE`:
  - Append `{ role: "user", content: event.text }` to `context.messages`.
  - Transition to `improvise.thinking`.

#### `improvise.thinking`

- Invoke: promise actor that calls `chat(context.messages, IMPROVISE_SYSTEM_PROMPT)`.
- `onDone`: print the response, append `{ role: "assistant", content }` to `context.messages`, transition to `improvise.listening`.
- `onError`: print error, transition to `improvise.listening`.
- Does **not** handle `MESSAGE` — the agent is busy processing.

## Context

```ts
{
  messages: Array<{ role: "user" | "assistant"; content: string }>
}
```

## Events

```ts
| { type: "MESSAGE"; text: string }
| { type: "PARTIALLY_RESPONDED" }
```

- `MESSAGE`: the user sent a message.
- `PARTIALLY_RESPONDED`: a state responded to the user's input but did not fully address it. The next state should inspect context and continue processing. Raised internally via `raise()`.

## LLM Integration

- SDK: `openai` (v4) with `baseURL: "https://openrouter.ai/api/v1"`.
- Model: `anthropic/claude-sonnet-4`.
- Auth: `OPENROUTER_API_KEY` env var passed as `apiKey`.
- Exported function: `chat(messages, systemPrompt?): Promise<string>` — calls `client.chat.completions.create` and returns the assistant content.
- When `systemPrompt` is provided, a `{ role: "system", content: systemPrompt }` message is prepended to the messages array sent to the API. The `messages` parameter type remains `"user" | "assistant"` — system messages are an internal concern of `chat()`.
- Called from a `fromPromise` actor inside the machine, not from `index.ts`.

### System Prompts

Each state that invokes the LLM provides its own system prompt, defined as a module-level constant in `machine.ts`:

- **`GREETINGS_SYSTEM_PROMPT`**: Instructs Atlas to respond in JSON `{ greeting, needsFollowUp }`. Greet in Portuguese, introduce itself briefly. Must only greet in the `greeting` field — not answer questions. `needsFollowUp = true` if the user made a request or asked a question beyond a simple greeting.
- **`IMPROVISE_SYSTEM_PROMPT`**: Defines Atlas's identity (name, role, tone, language). Instructs it to answer the user's questions.

## CLI Interface

- `readline/promises` from Node.js.
- Prompt: `"> "`.
- Loop:
  1. `await rl.question("> ")` — read a line.
  2. Send `{ type: "MESSAGE", text }` to the actor.
  3. `await waitForReady()` — wait until `actor.getSnapshot().can({ type: "MESSAGE" })` returns true (i.e. the machine can accept input again).
- The caller does **not** check state names. It uses `snapshot.can()` to determine readiness.
- Exit: `Ctrl+C` / `close` event.

## File Map

| File               | Responsibility                          |
| ------------------ | --------------------------------------- |
| `src/index.ts`     | Entry point — dotenv, actor, readline   |
| `src/machine.ts`   | XState machine definition + LLM invoke  |
| `src/openrouter.ts`| OpenAI client configured for OpenRouter |

## Out of Scope

- Tests (will be added in a future spec).
- Streaming responses.
- Conversation history persistence.
- Error handling beyond basic try/catch around the readline loop.
