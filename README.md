# AI Agent XState

Minimal AI agent (Atlas) built with XState v5 for learning state machine fundamentals. CLI interface that converses in Portuguese via OpenRouter (Claude Sonnet). Each state carries its own system prompt — the agent greets, then processes the user's message.

## Setup

```bash
npm install
cp .env.example .env
# Fill in OPENROUTER_API_KEY in .env
npm start
```

## Architecture

### C1 — System Context

```mermaid
flowchart LR
    user[User]:::entry

    system[AI Agent CLI]:::harness

    openrouter[OpenRouter API]:::external

    user -->|CLI stdin/stdout| system
    system -->|HTTPS chat completion| openrouter

    classDef entry fill:#ea580c,stroke:#9a3412,color:#fff
    classDef harness fill:#7c3aed,stroke:#5b21b6,color:#fff
    classDef external fill:#dc2626,stroke:#991b1b,color:#fff
```

### C2 — Containers

```mermaid
flowchart LR
    user[User]:::entry

    subgraph system [AI Agent]
        cli[CLI Entry Point]:::entry
        machine[Agent State Machine]:::harness
        openrouterClient[OpenRouter Client]:::code
    end

    subgraph externals [External Services]
        openrouter[OpenRouter API]:::external
    end

    subgraph legend [Legend]
        lEntry[Entry Point]:::entry
        lHarness[Harness]:::harness
        lCode[Code]:::code
        lExternal[External]:::external
    end

    user -->|1| cli
    cli -->|2| machine
    machine -->|3| openrouterClient
    openrouterClient -->|4| openrouter

    classDef entry fill:#ea580c,stroke:#9a3412,color:#fff
    classDef harness fill:#7c3aed,stroke:#5b21b6,color:#fff
    classDef code fill:#2563eb,stroke:#1e40af,color:#fff
    classDef external fill:#dc2626,stroke:#991b1b,color:#fff
```

| # | Origin -> Destination | Protocol | Payload |
|---|---|---|---|
| 1 | User -> CLI Entry Point | CLI stdin | plain text message |
| 2 | CLI Entry Point -> Agent State Machine | in-process `actor.send()` | `{ type: "MESSAGE", text }` |
| 3 | Agent State Machine -> OpenRouter Client | in-process invoke | `{ messages: Array<{ role, content }>, systemPrompt: string }` |
| 4 | OpenRouter Client -> OpenRouter API | HTTPS POST (sync) | `chat.completions.create` |

### Chat Flow

```mermaid
sequenceDiagram
    participant user as [ENTRY] User
    participant cli as [ENTRY] CLI Entry Point
    participant machine as [HARNESS] Agent State Machine
    participant client as [CODE] OpenRouter Client
    participant api as [EXT] OpenRouter API

    user->>cli: types first message
    cli->>machine: send MESSAGE event
    Note over machine: idle -> greetings (appendUserMessage)
    machine->>client: invoke callLLM([], GREETINGS_SYSTEM_PROMPT)
    client->>api: chat.completions.create
    api-->>client: completion response
    client-->>machine: greeting text (event.output)
    Note over machine: greetings -> improvise.listening (print greeting, append, raise PARTIALLY_RESPONDED)
    Note over machine: listening -> thinking (PARTIALLY_RESPONDED)
    machine->>client: invoke callLLM(messages, IMPROVISE_SYSTEM_PROMPT)
    client->>api: chat.completions.create
    api-->>client: completion response
    client-->>machine: assistant reply (event.output)
    Note over machine: thinking -> listening (print reply, append to context)

    loop conversation continues
        user->>cli: types question
        cli->>machine: send MESSAGE event
        Note over machine: listening -> thinking (appendUserMessage)
        machine->>client: invoke callLLM(messages, IMPROVISE_SYSTEM_PROMPT)
        client->>api: chat.completions.create
        api-->>client: completion response
        client-->>machine: assistant reply
        Note over machine: thinking -> listening
    end
```

### State Machine

```mermaid
---
title: State Machine — Atlas Agent
---
stateDiagram-v2
    [*] --> idle

    idle --> greetings: MESSAGE / appendUserMessage

    greetings --> improvise: onDone / print greeting, append, raise PARTIALLY_RESPONDED

    state improvise {
        [*] --> listening

        listening --> thinking: PARTIALLY_RESPONDED
        listening --> thinking: MESSAGE / appendUserMessage
        thinking --> listening: onDone / print reply, append assistant message
        thinking --> listening: onError / print error
    }

    note right of greetings
        Invoke state.
        Calls LLM with GREETINGS_SYSTEM_PROMPT.
        Raises PARTIALLY_RESPONDED on completion.
    end note

    note right of thinking
        Invokes callLLM actor (OpenRouter API)
        with IMPROVISE_SYSTEM_PROMPT.
        Does not accept MESSAGE while processing.
    end note

    note right of idle
        No terminal state.
        Agent runs until process exit (Ctrl+C).
    end note
```

## Project Structure

```
src/
  index.ts          # Entry point — readline loop + actor
  machine.ts        # XState state machine definition
  openrouter.ts     # OpenAI SDK client configured for OpenRouter
docs/
  specs/            # Behavior specifications (source of truth)
  design-decisions.md
  architecture/     # C4 + behavioral diagrams (.mmd)
```
