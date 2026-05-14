# 001 — Hello World Agent

## Goal

Minimal XState v5 agent with three linear states to learn the fundamentals before adding complexity.

## States

```
idle ──MESSAGE──▶ greetings ──always──▶ improvise
                                         ├── listening ──MESSAGE──▶ thinking
                                         └── thinking ──onDone───▶ listening
```

### `idle` (initial)

- No entry action.
- On event `MESSAGE` → transition to `greetings`.

### `greetings` (transient state)

- Entry action: print a greeting to stdout (e.g. `"Hello! I'm your AI agent. Ask me anything."`).
- `always` (unconditional, no guard) → transition to `improvise`. The agent greets and becomes available to listen in one step.

### `improvise` (compound state)

#### `improvise.listening` (initial)

- On event `MESSAGE`:
  - Append `{ role: "user", content: event.text }` to `context.messages`.
  - Transition to `improvise.thinking`.

#### `improvise.thinking`

- Invoke: promise actor that calls `chat(context.messages)`.
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
{ type: "MESSAGE"; text: string }
```

Single event type. The machine handles LLM calls internally via `invoke`.

## LLM Integration

- SDK: `openai` (v4) with `baseURL: "https://openrouter.ai/api/v1"`.
- Model: `anthropic/claude-sonnet-4`.
- Auth: `OPENROUTER_API_KEY` env var passed as `apiKey`.
- Exported function: `chat(messages): Promise<string>` — calls `client.chat.completions.create` and returns the assistant content.
- Called from a `fromPromise` actor inside the machine, not from `index.ts`.

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
