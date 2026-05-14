# 002 — Tool Use

## Goal

Add function calling to the `improvise` mode. The LLM can call tools, receive results, and call more tools (multi-step) until it produces a text response. Tool execution is internal to the actor — the state machine does not change.

## States

```
idle ──MESSAGE──▶ greetings ──onDone──▶ improvise
                  (raises PARTIALLY_RESPONDED only if needsFollowUp)

improvise:
├── listening ──MESSAGE────────────────▶ thinking
│             ──PARTIALLY_RESPONDED────▶ thinking
└── thinking ──onDone──────────────────▶ listening
```

No new states. No new events. The diagram is identical to spec 001.

### Changed state: `improvise.thinking`

- Invoke: `improviseThinkingNode` actor — internally runs a loop: call the LLM with tools → if the response contains tool calls, execute them, append the results, call the LLM again → repeat until the LLM returns a text response with no tool calls.
- The actor receives `context.messages` and returns all messages generated during the loop (assistant messages with tool_calls, tool result messages, and the final assistant text message).
- `onDone`:
  - Print the final assistant text to stdout.
  - Append all returned messages to `context.messages`.
  - Transition to `improvise.listening`.
- `onError`: unchanged.

### Unchanged states

`idle`, `greetings`, `improvise.listening` — no changes.

## Context

```ts
{
  messages: Array<
    | { role: "user"; content: string }
    | { role: "assistant"; content: string; tool_calls?: undefined }
    | { role: "assistant"; content: null; tool_calls: ToolCall[] }
    | { role: "tool"; content: string; tool_call_id: string }
  >;
}
```

Where:
```ts
type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};
```

No new context fields. The messages array stores everything, including intermediate tool interactions, so the actor receives the full history directly without reconstructing anything.

Assistant messages with `tool_calls` have `content: null` (the LLM chose to call tools instead of responding). Assistant messages with text have no `tool_calls`. These are mutually exclusive in practice.

Note: `tool_calls` and `tool_call_id` use snake_case to match the OpenAI API format — these messages are sent directly to the API.

## Events

```ts
| { type: "MESSAGE"; text: string }
| { type: "PARTIALLY_RESPONDED" }
```

No new events. Tool execution is internal to the actor.

## LLM Integration

New function in `openrouter.ts`:

```ts
chatWithTools(
  messages: Message[],
  systemPrompt: string,
  tools: ToolDefinition[]
): Promise<{ content: string | null; toolCalls: ToolCall[] | null }>
```

- Passes `tools` to `client.chat.completions.create`.
- Returns the assistant response structure (content + tool_calls).
- Called in a loop by the actor, not by the machine directly.
- The existing `chat()` function remains unchanged — `greetingsNode` continues to use it.

## Tool Definitions

Tool definitions are per-state constants in `machine.ts` (extending DD-005: system prompts are per-state, tool definitions follow the same principle).

```ts
const IMPROVISE_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "get_current_time",
      description: "Returns the current date and time in ISO 8601 format.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
];
```

## Tool Registry

Module-level constant mapping tool names to implementations:

```ts
const TOOL_REGISTRY: Record<string, (args: Record<string, unknown>) => string> = {
  get_current_time: () => new Date().toISOString(),
};
```

The actor looks up each tool call's `function.name` in the registry, parses `function.arguments` as JSON, calls the function, and collects the result as a string.

Unknown tool names return an error string (e.g., `"Unknown tool: xyz"`), not a thrown error — the LLM should see the failure and recover.

## Actor Loop (improviseThinkingNode)

```
messages = context.messages (received from machine)
loop:
  response = chatWithTools(messages, IMPROVISE_SYSTEM_PROMPT, IMPROVISE_TOOLS)
  append assistant message to messages
  if response.toolCalls is empty → break
  for each toolCall:
    result = TOOL_REGISTRY[toolCall.function.name](args)
    append { role: "tool", content: result, tool_call_id: toolCall.id } to messages
return all new messages (everything appended after the original context.messages)
```

The loop runs inside a single `fromPromise` actor. From the machine's perspective, `thinking` invokes one actor and gets one result — the loop is an implementation detail.

## File Map

| File | Change |
|---|---|
| `docs/specs/002-tool-use.md` | New spec (this document) |
| `docs/specs/README.md` | Add 002 to index |
| `src/openrouter.ts` | Add `chatWithTools()` |
| `src/machine.ts` | Update `improviseThinkingNode` to use `chatWithTools` in a loop, add `IMPROVISE_TOOLS` constant, add `TOOL_REGISTRY`, update context message type |
| `test/machine.test.ts` | New tests for tool use scenarios |

## Out of Scope

- Parallel tool execution (tools execute sequentially within the loop).
- Tool timeout/cancellation.
- Streaming tool results.
- Tool definitions in greetings state.
- Dynamic tool registration at runtime.
