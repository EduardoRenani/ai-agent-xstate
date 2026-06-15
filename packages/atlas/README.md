# @eduardorenani/atlasjs

Mode-based agent orchestration on top of [XState v5](https://stately.ai/docs/xstate).

> **Alpha.** The API is stable enough to build with, but minor 0.x bumps may still break shape. Pin exact versions.

## Why

Building an AI agent on a raw state machine forces every mode (greeting, answering, teaching, etc.) into ad-hoc actor/onDone/guard plumbing. `@eduardorenani/atlasjs` collapses that into three constructors and a small result contract so the agent's structure stays in the modes — not in the wiring.

- A **mode** is a unit of agentic work with one well-defined **goal**.
- A mode's `behavior` returns a **`ModeResult`**: either **leave** with an `outcome` (`achieved` / `abandoned`) or **stay** and re-run with a `stay` continuation (`replay` / `waitOnEvent`). Rejections are caught and routed through a synthesized `error` bucket.
- **Exits are bound to outcomes** — routing is over the outcome plus its typed payload, never over arbitrary conditions.

One unified `defineMode` covers everything. How a mode is *activated* is a single bit, `start`:

- `start: "run"` (default) — enters by **running** the behavior immediately (dry run, no event yet).
- `start: "event"` — enters **parked**; the behavior runs only when a declared event arrives.

Because a behavior can `stay: "replay"` (re-run now) or `stay: "waitOnEvent"` (re-run on the next event), a single mode can both *do work* and *wait for input* — no more forcing every chatbot mode into a `listening + working` compound.

## Install

```bash
npm install @eduardorenani/atlasjs@alpha
```

Node 20+ required, ESM only.

## 30-second tour

A trivial agent with two modes: `listening` parks for a user message, `answering` calls an LLM and routes back to `listening`.

```ts
import { defineMode, defineAgent, startAgent } from "@eduardorenani/atlasjs";

type Ctx = { question: string; answer: string };
type Ev = { type: "ASK"; question: string };

// Event-mode — parks on entry, runs its behavior only when a declared event
// arrives. `event` is narrowed to the declared `events`.
const listening = defineMode<Ctx, Ev, { question: string }>({
    start: "event",
    events: ["ASK"],
    input: () => null,
    behavior: async ({ event }) => ({
        outcome: "achieved",
        payload: { question: event.question },
    }),
    routes: {
        achieved: {
            target: "answering",
            assign: ({ payload }) => ({ question: payload.question }),
        },
        abandoned: { target: "answering" },
    },
});

// Run-mode (the default) — runs its async `behavior` immediately and dispatches
// on the result. Both exit buckets (achieved / abandoned) are required.
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
    modes: { listening, answering },
});

const actor = startAgent(machine); // Ctx/Ev inferred from the agent handle
actor.send({ type: "ASK", question: "What is a mode?" });
```

`behavior` returns `{ outcome, payload }` (leave) or `{ stay, payload }` (re-run). The route on `achieved` is the **only** way out of a successful run — there is no untyped escape hatch.

`startAgent` is the runtime boundary: hosts never import from `xstate` directly. The returned actor exposes `send`, `stop`, and `getSnapshot` — nothing else from XState's surface leaks out.

## Self-suspending modes (`stay`)

A behavior that hasn't reached its goal returns a **continuation** instead of an outcome:

```ts
const socratic = defineMode<Ctx, Ev, Payload>({
    events: ["MESSAGE"],
    input: ({ context }) => ({ messages: context.messages }),
    behavior: async ({ event, deps }) => {
        if (event?.type === "MESSAGE") {
            // evaluate the reply → leave, or keep going
            return understood
                ? { outcome: "achieved", payload }
                : { stay: "replay", payload };   // re-teach now
        }
        await deps.teach(...);                   // dry-run entry: teach
        return { stay: "waitOnEvent", payload }; // then park for the reply
    },
    routes: { achieved: { target: "classifying" }, abandoned: { target: "classifying" } },
    stay: { waitOnEvent: {}, replay: {} },
});
```

- `stay: "replay"` — re-run the behavior **now** (run-mode: no event; event-mode: the same event).
- `stay: "waitOnEvent"` — re-run when the **next** declared event arrives.

`routes` holds the exits (each carries a `target`); `stay` holds the continuations (assign only, no target).

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
            // Atlas-vocabulary event. `from` / `to` are dot-joined mode paths;
            // `e.awaiting` lists the event types a parked mode will resume on.
            if (e.awaiting && e.awaiting.length > 0 && resolveReady) {
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

### Fire-and-log via `onError`

When a `behavior` rejects and **no** `routes.error` entry catches it (absent route, no matched `when`, or matched `target: RE_THROW`), the rejection escapes the machine. `startAgent({ onError })` is the host-side hook — it fires precisely when XState would otherwise raise an uncaught error. Intra-machine recovery (`routes.error: { target: <sibling> }`) is unchanged and the host observes only the recovery transition through `inspect`.

```ts
import { startAgent, type AgentErrorInfo } from "@eduardorenani/atlasjs";

startAgent<Ctx, Ev>(machine, {
    onError: (info: AgentErrorInfo<Ctx>) => {
        // info.error      — raw rejection (unknown)
        // info.modePath   — dot-joined leaf path, e.g. "socratic"
        // info.context    — root context after any routes.error.assign ran
        // info.snapshot   — AgentSnapshot pointing at the failed leaf
        logger.error({ err: info.error, modePath: info.modePath, traceId }, "agent escape");
    },
});
```

`onError` is opt-in: when omitted, the wrapper makes no `subscribe` call and Node's default unhandled-rejection propagation applies (strictly additive — no migration). Full contract in [`docs/specs/010-error-channel.md`](https://github.com/EduardoRenani/atlas/blob/main/docs/specs/010-error-channel.md).

## The three constructors

| Constructor          | Purpose                                                                   |
| -------------------- | ------------------------------------------------------------------------- |
| `defineMode`         | A leaf mode. Always `{ input, behavior, routes }` (+ optional `events` / `stay`). `start: "run" \| "event"` controls how it activates. |
| `defineCompoundMode` | A composite of nested modes. Children route to `END` to exit; the compound's `routes` pick the destination. |
| `defineAgent`        | The top-level entry. Compiles to an XState machine; boot it with `startAgent`. |

## Concepts in 60 seconds

- **Mode** — one unified primitive with a `behavior` returning `ModeResult<TPayload>`. `start: "run"` (default) runs on entry; `start: "event"` parks until a declared event. Routing is declared upfront: `routes.{achieved,abandoned}` for exits, `stay.{replay,waitOnEvent}` for continuations. Optional `routes.error` catches rejections; if absent, errors re-throw above the actor (no silent swallow).
- **Outcome vs. stay** — `outcome` LEAVES the mode (dispatched by `routes`, each with a `target`); `stay` REMAINS and re-runs (dispatched by `stay`, no target). The two are mutually exclusive in the return type.
- **Compound mode** — groups child modes under an `initial` slot. Children exit the compound by routing to `END`; the compound's `routes` decide where to go next. Compounds can declare lexically-scoped `context` (inherited keys + local resets on re-entry) and an `output` callback that shapes the payload its parent routes on.
- **Deps** — `defineAgent({ deps: { ... } })` exposes a frozen container of external resources (DB, logger, LLM client) to every `input` / `behavior` / `assign`. Defaults to `{}` when omitted.
- **JSON-safe context** — `context` (root and compound-local) is checked against `JsonCompatible<T>` so snapshots round-trip through any storage layer.

## Where to go next

- **API reference** — the type signatures and JSDoc in [`packages/atlas/src/types.ts`](https://github.com/EduardoRenani/atlas/blob/main/packages/atlas/src/types.ts) are the source of truth.
- **Worked example** — [`examples/zoe/`](https://github.com/EduardoRenani/atlas/tree/main/examples/zoe) is a CLI agent that classifies user intent and dispatches across greetings / improvising / socratic modes, and persists every turn via file-backed snapshots.
- **Specs** — the contract lives in [`docs/specs/004-xstate-agent-wrapper.md`](https://github.com/EduardoRenani/atlas/blob/main/docs/specs/004-xstate-agent-wrapper.md), [`005-agent-deps-and-stringifiable-context.md`](https://github.com/EduardoRenani/atlas/blob/main/docs/specs/005-agent-deps-and-stringifiable-context.md), [`006-modes-not-states.md`](https://github.com/EduardoRenani/atlas/blob/main/docs/specs/006-modes-not-states.md), [`009-snapshot-aware-rehydration.md`](https://github.com/EduardoRenani/atlas/blob/main/docs/specs/009-snapshot-aware-rehydration.md), [`010-error-channel.md`](https://github.com/EduardoRenani/atlas/blob/main/docs/specs/010-error-channel.md), and [`011-self-suspending-modes.md`](https://github.com/EduardoRenani/atlas/blob/main/docs/specs/011-self-suspending-modes.md) (the unified mode model — `start`, `outcome` vs `stay`).
- **Design decisions** — [`docs/design-decisions.md`](https://github.com/EduardoRenani/atlas/blob/main/docs/design-decisions.md) records the "why" behind the result contract, goal-bound exits, and the modes-not-states vocabulary.

## License

Apache-2.0. See [`LICENSE`](https://github.com/EduardoRenani/atlas/blob/main/LICENSE).
