# Architecture Documentation

Auto-generated from code. Do not edit manually.

Diagrams document **Zoe** — the example agent under `examples/zoe/`. The state machine is compiled by `packages/atlas/` (the library); atlas itself has no runtime topology.

## C4 Diagrams

| Artifact | Description |
|---|---|
| [c4/c1-context.mmd](c4/c1-context.mmd) | System context — User, AI Agent CLI, OpenRouter API |
| [c4/c2-container.mmd](c4/c2-container.mmd) | Container view — CLI Entry Point, Agent State Machine, LLM Client, OpenRouter API |
| [c4/c2-container.md](c4/c2-container.md) | Interface table companion for c2-container.mmd |
| [c4/flows/user-chat.mmd](c4/flows/user-chat.mmd) | Sequence diagram — user chat turn: `listening` parks for MESSAGE, classifier routes to greetings / socratic / improvising / listening, with socratic as a single self-suspending mode (TEACH/EVALUATE phases) |

## Behavioral Diagrams

| Artifact | Description |
|---|---|
| [behavioral/state-machines/agent.mmd](behavioral/state-machines/agent.mmd) | State machine — Zoe Agent under Spec 011 unified modes: `listening` (start:event), classifying, greetings, improvising, and the self-suspending `socratic` leaf with its replay / waitOnEvent loops and circuit-breaker exit |
