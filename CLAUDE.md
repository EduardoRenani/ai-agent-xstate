# Project rules

## SDK goal

Atlas is an agent-orchestration library built around **modes**. It behaves like a state machine: each mode is a "mental state" the agent is in, and at any moment the agent occupies exactly one. A mode defines:

- **Objective** — the specific goal the agent pursues while in this mode.
- **Tools** — the set of tools available to the agent in this mode.
- **Completion criterion** — the condition that signals the objective has been achieved (transition out on success).
- **Abandonment criterion** — the condition that ends the mode without success, so the agent never stays stuck in one state forever.

Orchestration is the movement between modes as these criteria fire.

## XState is scaffolding, not foundation

XState was chosen as a starting point to make the project easier to bootstrap — nothing more. It must **not** be treated as a reference for how to solve problems or shape the design.

- The lib owns its own opinions and interface; XState is a support dependency, used until it can eventually be replaced.
- Never let XState concepts leak into the public API or the mental model of the lib.
- Always implement code so that ripping XState out later is an easy refactor — isolate it behind our own abstractions, keep the coupling thin and localized.

## TypeScript

- **No `any`.** Never use `any` in type annotations, casts, or generics. If you cannot find a proper type, stop and ask for explicit permission — explain what you tried and why you cannot type it correctly.
- **Strict nulls.** `strictNullChecks` is always on. Never suppress null/undefined checks with `!` (non-null assertion) unless the safety is proven and commented.

## Formatting

- Indent with **4 spaces** (tabs are spaces, tab width = 4).

## Specs

- Spec index lives at `docs/specs/README.md`.
