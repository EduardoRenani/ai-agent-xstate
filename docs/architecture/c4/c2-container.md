# C2 Container — AI Agent

Companion de `c2-container.mmd`. Gerado automaticamente — nao edite manualmente.

## Interfaces

| # | Origin -> Destination | Protocol | Payload |
|---|---|---|---|
| 1 | User -> CLI Entry Point | CLI stdin | plain text message |
| 2 | CLI Entry Point -> Agent State Machine | in-process `actor.send()` | `{ type: "MESSAGE", text: string }` |
| 3 | Agent State Machine -> OpenRouter Client | in-process invoke (promise actor) | `Array<{ role, content }>` |
| 4 | OpenRouter Client -> OpenRouter API | HTTPS POST (sync) | `chat.completions.create` request |
