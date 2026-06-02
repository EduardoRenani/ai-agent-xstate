# @eduardorenani/atlasjs

Mode-based agent orchestration on top of [XState v5](https://stately.ai/docs/xstate).

> **Alpha.** The API is stable enough to build with, but minor 0.x bumps may still break shape. Pin exact versions.

## Why

Building an AI agent on a raw state machine forces every mode (greeting, answering, teaching, etc.) into ad-hoc actor/onDone/guard plumbing. `@eduardorenani/atlasjs` collapses that into three constructors and a four-outcome contract so the agent's structure stays in the modes — not in the wiring.

- A **mode** is a unit of agentic work with one well-defined **goal**.
- Every mode terminates with one of four **outcomes**: `achieved` / `retry` / `abandoned` / `error`.
- **Exits are bound to outcomes** — routing is over the outcome plus its typed payload, never over arbitrary conditions.

The type system rejects anything that does not fit: active+passive mixing in the same leaf mode, modes missing outcomes, cross-compound targets, `retry` with an arbitrary target.

## Install

```bash
npm install @eduardorenani/atlasjs@alpha xstate
```

`xstate@^5` is a peer dependency — install it explicitly. Node 20+ required, ESM only.

## 30-second tour

A trivial agent with two modes: `listening` waits for a user message, `answering` calls an LLM and routes back to `listening`.

```ts
import { defineMode, defineAgent, startAgent } from "@eduardorenani/atlasjs";

type Ctx = { question: string; answer: string };
type Ev = { type: "ASK"; question: string };

// Passive mode — waits for an event. Inline callbacks aren't allowed in `on`;
// transitions reference reusable actions declared on `defineAgent` below.
const listening = defineMode<Ctx, Ev>({
    on: {
        ASK: {
            target: "answering",
            actions: "captureQuestion",
        },
    },
});

// Active mode — runs an async `behavior` and dispatches on its outcome.
// All three outcome buckets (achieved / retry / abandoned) are required;
// pass `[]` for retry when there's no retry policy.
const answering = defineMode<Ctx, Ev, { answer: string }>({
    input: ({ context }) => ({ question: context.question }),
    behavior: async ({ input }) => {
        const { question } = input as { question: string };
        const answer = await callYourLLM(question);
        return { outcome: "achieved", payload: { answer } };
    },
    routes: {
        achieved: {
            target: "listening",
            assign: ({ payload }) => ({ answer: payload.answer }),
        },
        retry: [],
        abandoned: { target: "listening" },
    },
});

const machine = defineAgent<
    Ctx,
    Ev,
    { listening: typeof listening; answering: typeof answering }
>({
    id: "qa",
    initial: "listening",
    context: { question: "", answer: "" },
    events: {} as Ev,
    actions: {
        captureQuestion: ({ event }) => ({ question: event.question }),
    },
    modes: { listening, answering },
});

const actor = startAgent<Ctx, Ev>(machine);
actor.send({ type: "ASK", question: "What is a mode?" });
```

`behavior` returns `{ outcome, payload }`. The route on `achieved` is the **only** way out of a successful run — there is no untyped escape hatch.

`startAgent` is the runtime boundary: hosts never import from `xstate` directly. The returned actor exposes `send`, `stop`, and `getSnapshot` — nothing else from XState's surface leaks out.

## Multi-turn agents (snapshot rehydration)

For agents that span multiple turns, `actor.getSnapshot()` returns an opaque `AgentSnapshot<Ctx>` that round-trips through `JSON.stringify` / `JSON.parse`. Feed it back as `startAgent({ snapshot })` next turn and the agent resumes mid-conversation — including `local` slots declared on `defineCompoundMode`'s `context`.

```ts
async function runTurn(
    text: string,
    snapshot?: AgentSnapshot<Ctx>,
): Promise<AgentSnapshot<Ctx>> {
    let resolveReady: (() => void) | null = null;
    const actor = startAgent<Ctx, Ev>(machine, {
        snapshot,
        inspect: (e) => {
            // Atlas-vocabulary event. `from` / `to` are dot-joined mode paths
            // (e.g. "socratic.teaching"). Phase 1 emits `transition` only.
            if (e.to === "listening" && resolveReady) {
                const r = resolveReady;
                resolveReady = null;
                r();
            }
        },
    });
    const ready = new Promise<void>((r) => { resolveReady = r; });
    actor.send({ type: "ASK", question: text });
    await ready;
    const next = actor.getSnapshot();
    actor.stop();
    return next;
}
```

The canonical multi-turn host is one `runTurn` call per incoming message: load the previous snapshot from storage, run one turn, persist the new snapshot. `examples/zoe/` ships this end-to-end with a file-backed session store. Contract details in [`docs/specs/009-snapshot-aware-rehydration.md`](https://github.com/EduardoRenani/atlas/blob/main/docs/specs/009-snapshot-aware-rehydration.md).

## The three constructors

| Constructor          | Purpose                                                                   |
| -------------------- | ------------------------------------------------------------------------- |
| `defineMode`         | A leaf mode. Pass `{ input, behavior, routes }` for active, `{ on }` for passive. Mixing is a compile error. |
| `defineCompoundMode` | A composite of nested modes. Routes to `END` to exit; the enclosing scope's `onDone` picks the destination. |
| `defineAgent`        | The top-level entry. Compiles to an XState machine; boot it with `startAgent`. |

## Concepts in 60 seconds

- **Active mode** — runs an async `behavior` that returns `ModeOutput<TPayload>`. Routing is declared upfront under `routes.{achieved,retry,abandoned}`. Optional `routes.error` catches rejections; if absent, errors re-throw above the actor (no silent swallow).
- **Passive mode** — waits for events declared in `on`. Transitions reference named `actions` on `defineAgent`, never inline closures (keeps DD-004 churn out of state files).
- **Compound mode** — groups child modes under an `initial` slot. Children exit the compound by routing to `END`; the parent's `onDone` decides where to go next. Compounds can declare lexically-scoped `context` (inherited keys + local resets on re-entry).
- **Deps** — `defineAgent({ deps: { ... } })` exposes a frozen container of external resources (DB, logger, LLM client) to every `input` / `behavior` / `assign`. Defaults to `{}` when omitted.
- **JSON-safe context** — `context` (root and compound-local) is checked against `JsonCompatible<T>` so snapshots round-trip through any storage layer.

## Where to go next

- **API reference** — the type signatures and JSDoc in [`packages/atlas/src/types.ts`](https://github.com/EduardoRenani/atlas/blob/main/packages/atlas/src/types.ts) are the source of truth.
- **Worked example** — [`examples/zoe/`](https://github.com/EduardoRenani/atlas/tree/main/examples/zoe) is a CLI agent that classifies user intent and dispatches across greetings / improvising / socratic modes, and persists every turn via file-backed snapshots.
- **Specs** — the API contract lives in [`docs/specs/004-xstate-agent-wrapper.md`](https://github.com/EduardoRenani/atlas/blob/main/docs/specs/004-xstate-agent-wrapper.md), [`005-agent-deps-and-stringifiable-context.md`](https://github.com/EduardoRenani/atlas/blob/main/docs/specs/005-agent-deps-and-stringifiable-context.md), [`006-modes-not-states.md`](https://github.com/EduardoRenani/atlas/blob/main/docs/specs/006-modes-not-states.md), and [`009-snapshot-aware-rehydration.md`](https://github.com/EduardoRenani/atlas/blob/main/docs/specs/009-snapshot-aware-rehydration.md) (the `startAgent` actor surface + multi-turn persistence contract).
- **Design decisions** — [`docs/design-decisions.md`](https://github.com/EduardoRenani/atlas/blob/main/docs/design-decisions.md) records the "why" behind the four-outcome contract, goal-bound exits, and the modes-not-states vocabulary.

## License

Apache-2.0. See [`LICENSE`](https://github.com/EduardoRenani/atlas/blob/main/LICENSE).
