# @eduardorenani/atlasjs — Usage

> Companion to [`packages/atlas/README.md`](../packages/atlas/README.md). This
> page is the working-developer reference: install, define modes, compose them
> into an agent, run it, and persist state across turns. The exhaustive type
> contract lives in [`packages/atlas/src/types.ts`](../packages/atlas/src/types.ts);
> the rationale for each shape lives in
> [`docs/specs/004-xstate-agent-wrapper.md`](specs/004-xstate-agent-wrapper.md),
> [`005`](specs/005-agent-deps-and-stringifiable-context.md),
> [`006`](specs/006-modes-not-states.md),
> [`009`](specs/009-snapshot-aware-rehydration.md) (the `startAgent` actor
> surface + multi-turn snapshot contract), and
> [`010`](specs/010-error-channel.md) (the host-side `onError` channel).

## 1. Install

```bash
npm install @eduardorenani/atlasjs@alpha xstate
```

- `xstate@^5` is a peer dependency.
- ESM only. Node ≥ 20.
- TypeScript ≥ 5 strongly recommended (the API is typed end-to-end; using it
  from plain JS works but loses the four-outcome / goal-bound guarantees that
  motivate the library).

## 2. Mental model

An **agent** is a tree of **modes**. Every mode has a goal.

- A **leaf mode** is either `active` (runs an async `behavior`) or `passive`
  (waits for events). It is constructed with `defineMode`. Mixing the two
  shapes in one config is a compile error.
- A **compound mode** is a parent that contains other modes. It is constructed
  with `defineCompoundMode`. Children exit the compound by routing to the `END`
  sentinel; the compound's `onDone` decides where to go next.
- The **agent** is the root. Constructed with `defineAgent`. Compiles to an
  XState v5 machine; boot it with `startAgent` (`xstate` stays an
  implementation detail — user code never imports from it).

The whole tree is type-checked against one `TContext` (root) and one `TEvents`
union. Children of a `defineCompoundMode` can lexically narrow the context
they see (`inherit` selects which parent keys propagate; `local` declares own
keys that reset on every re-entry).

## 3. Define a leaf mode

### 3a. Active

An active leaf runs `input` → `behavior` → routes on the resulting
`ModeOutput`.

```ts
import { defineMode, END } from "@eduardorenani/atlasjs";
import type { ModeOutput } from "@eduardorenani/atlasjs";

type Ctx = { question: string; answer: string };
type Ev  = { type: "ASK"; question: string };

export const answering = defineMode<Ctx, Ev, { answer: string }>({
    // `input` projects the bits of context (and deps) the behavior needs.
    input: ({ context }) => ({ question: context.question }),

    // `behavior` must return { outcome, payload }. The three outcomes have
    // independent route buckets below.
    behavior: async ({ input }): Promise<ModeOutput<{ answer: string }>> => {
        const { question } = input as { question: string };
        const answer = await callYourLLM(question);
        return { outcome: "achieved", payload: { answer } };
    },

    routes: {
        achieved: {
            target: "listening",
            assign: ({ payload }) => ({ answer: payload.answer }),
        },
        // `retry: []` = "no special handling, just re-enter the same mode".
        retry: [],
        abandoned: { target: "listening" },
        // `error` is optional. When omitted, rejections rethrow above the
        // actor — no silent swallow. Provide it to recover or rebrand:
        // error: { target: "listening", assign: ({ error }) => ({ ... }) },
    },
});
```

**Rules the compiler enforces:**

- All three of `achieved`, `retry`, `abandoned` must be present.
- `retry` entries have no `target` — retry is structurally a self-loop.
- `target` values must name a sibling in the immediate enclosing `modes` map
  (or `END` to leave a compound). Dotted paths and XState absolute paths are
  rejected.
- Multi-entry arrays follow "first match wins, last entry is the default":
  every non-last entry must carry `when`; the last entry must omit it.

### 3b. Passive

A passive leaf idles until one of the events in `on` fires.

```ts
import { defineMode } from "@eduardorenani/atlasjs";

export const listening = defineMode<Ctx, Ev>({
    on: {
        ASK: {
            target: "answering",
            // `actions` references reusable callbacks declared on defineAgent.
            // Inline closures are NOT accepted here.
            actions: "captureQuestion",
        },
    },
});
```

Why named actions instead of inline callbacks? See DD-004 — inline closures in
state-file transitions caused churn whenever a new event variant landed. Named
actions centralize the mutation logic at the agent root, keeping state files
declarative.

## 4. Compose modes into a compound

```ts
import { defineCompoundMode, END } from "@eduardorenani/atlasjs";

export const socratic = defineCompoundMode<Ctx, Ev, undefined, {
    teaching: typeof teaching;
    listening: typeof listeningInSocratic;
    evaluating: typeof evaluating;
}>({
    initial: "teaching",
    modes: { teaching, listening: listeningInSocratic, evaluating },
    // Where the parent goes when ANY child routes to END.
    onDone: "classifying",
});
```

For lexical context narrowing:

```ts
const socratic = defineCompoundMode<
    Ctx,
    Ev,
    { inherit: readonly ["messages"]; local: { attempts: number } },
    { ... }
>({
    context: {
        inherit: ["messages"] as const,  // children see ctx.messages only
        local: { attempts: 0 },           // own keys, reset on every re-entry
    },
    initial: "teaching",
    modes: { ... },
    onDone: "classifying",
});
```

## 5. Build the agent

```ts
import { defineAgent, startAgent } from "@eduardorenani/atlasjs";

export const machine = defineAgent<
    Ctx,
    Ev,
    {
        listening: typeof listening;
        answering: typeof answering;
        socratic:  typeof socratic;
    }
>({
    id: "qa",
    initial: "listening",
    context: { question: "", answer: "" },
    events: {} as Ev,                  // phantom — only the type matters
    deps: { logger: console } as const, // optional, frozen, propagates to every callback
    actions: {
        captureQuestion: ({ event }) => ({ question: event.question }),
    },
    modes: { listening, answering, socratic },
});

const actor = startAgent<Ctx, Ev>(machine);
actor.send({ type: "ASK", question: "What is a mode?" });
```

`startAgent` is the runtime boundary: it auto-starts the actor and returns an
`AgentActor<Ctx, Ev>` exposing `send` / `stop` / `getSnapshot` — nothing else
from XState's API leaks out. Observation is construction-time only via
`startAgent(machine, { inspect })`; the callback receives an Atlas-vocabulary
event (`{ type: "transition", from, to, context }`) with `from` / `to` as
dot-joined mode paths (e.g. `"socratic.teaching"`). See spec
[`009`](specs/009-snapshot-aware-rehydration.md) §`AgentInspectionEvent`.

## 6. Multi-turn agents (snapshot rehydration)

For agents that span multiple turns — chat sessions, conversational flows,
anything where state must survive the process — `actor.getSnapshot()` returns
an opaque `AgentSnapshot<Ctx>` that JSON-round-trips through any storage
layer. Feed it back as `startAgent(machine, { snapshot })` next turn and the
agent resumes mid-conversation, including `local` slots declared on
`defineCompoundMode`'s `context`. (DD-018's reset-on-re-entry rule still
applies to intra-turn re-entries — the snapshot path is the one exception.)

The canonical multi-turn host is one `runTurn(text, snapshot?)` call per
incoming message: boot from the previous snapshot, send the event, await the
agent's return to its ready leaf via the `inspect` callback, capture the new
snapshot, stop the actor.

```ts
import { startAgent, type AgentSnapshot } from "@eduardorenani/atlasjs";

async function runTurn(
    text: string,
    snapshot?: AgentSnapshot<Ctx>,
): Promise<AgentSnapshot<Ctx>> {
    let resolveReady: (() => void) | null = null;
    const actor = startAgent<Ctx, Ev>(machine, {
        snapshot,
        inspect: (e) => {
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

The readiness gate is host-implemented from the `inspect` primitive — the
host knows which leaf consumes the next user event; Atlas does not infer it.
`AgentSnapshot` is JSON-safe by construction (the brand is type-only), so
persistence is `await writeFile(id, JSON.stringify(snapshot))` and load is
`JSON.parse(await readFile(id)) as AgentSnapshot<Ctx>` at the trust boundary.
[`examples/zoe/`](../examples/zoe) ships this end-to-end with a file-backed
session store. Full contract in spec
[`009`](specs/009-snapshot-aware-rehydration.md) §Persistence Contract.

**What survives a snapshot round-trip:** root context, active mode path,
compound `local` slots on the active path. **What does not:** active `after`
timers (XState limitation) and any pending events queued mid-turn (out of
scope — hosts dispatch one event per turn).

### Handling escapes (`onError`)

When a leaf's `behavior` rejects and **no** `routes.error` entry catches it
(absent route, no matched `when`, or matched `target: RE_THROW`), the
rejection escapes the machine. Without an `onError` callback this becomes
a process-level uncaught error and the readiness gate above never settles.
`startAgent({ onError })` is the host-side hook:

```ts
import { startAgent, type AgentSnapshot, type AgentErrorInfo } from "@eduardorenani/atlasjs";

async function runTurn(
    text: string,
    snapshot: AgentSnapshot<Ctx> | undefined,
    requestCtx: { traceId: string; userId: string },
): Promise<AgentSnapshot<Ctx>> {
    let resolveReady: (() => void) | null = null;
    let escaped: AgentErrorInfo<Ctx> | null = null;

    const actor = startAgent<Ctx, Ev>(machine, {
        snapshot,
        inspect: (e) => {
            if (e.to === "listening" && resolveReady) {
                const r = resolveReady;
                resolveReady = null;
                r();
            }
        },
        onError: (info) => {
            logger.error({
                err: info.error,
                modePath: info.modePath,
                traceId: requestCtx.traceId,
                userId: requestCtx.userId,
            }, "agent escape");
            escaped = info;
            if (resolveReady) {
                const r = resolveReady;
                resolveReady = null;
                r();
            }
        },
    });

    const ready = new Promise<void>((r) => { resolveReady = r; });
    actor.send({ type: "ASK", question: text });
    await ready;

    // Fire-and-log: persist the prior turn's snapshot so the next turn
    // restarts at `listening`. To re-enter the failed leaf instead, use
    // `escaped.snapshot`.
    const next = escaped !== null ? (snapshot ?? actor.getSnapshot()) : actor.getSnapshot();
    actor.stop();
    return next;
}
```

`onError` fires only when the rejection escapes — intra-machine recovery
via `routes.error: { target: <sibling> }` consumes the rejection silently,
and the host observes only the recovery transition through `inspect`.
When `onError` is omitted, the wrapper makes no `subscribe` call and
XState's default propagation applies (strictly additive, no migration
required). Full contract in spec
[`010`](specs/010-error-channel.md) §Behavior Contract.

## 7. Deps & JSON-safe context

- **`deps`** — a frozen, JSON-incompatible (functions allowed!) container of
  external resources. Forwarded to every `input` / `behavior` / `assign` /
  `guard`. Defaults to `{}` when omitted; user code receives `Readonly<TDeps>`.
- **`context`** — root and compound-local context is structurally constrained
  to `JsonCompatible<T>`. The compiler rejects `Date`, `Map`, `Set`, functions,
  and class instances with methods. The point is snapshot round-trip — what
  goes into `JSON.stringify(actor.getSnapshot())` must come back the same
  shape on rehydrate. Spec 005 §P5; the rehydration contract that consumes
  this is spec 009 §Persistence Contract.

## 8. What you do not do

- **No raw XState configs in `modes` slots.** Only `defineMode` /
  `defineCompoundMode` outputs are accepted. The brand on the slot type
  enforces this at compile time.
- **No active+passive mix.** A single leaf is either active (`{ input,
  behavior, routes }`) or passive (`{ on }`). Mixing keys is a compile error.
- **No silent error swallow.** Omit `routes.error` and rejections rethrow
  above the actor. The shorthand "I'll deal with it later" doesn't exist.
- **No inline callbacks in passive `on`.** Use named `actions` on
  `defineAgent`.

## 9. Versioning & install pins

The library is alpha. Pre-1.0 versions publish under the `alpha` dist-tag —
`npm install @eduardorenani/atlasjs` without a tag will fail to resolve (no `latest` yet).
Use `@eduardorenani/atlasjs@alpha` to track the latest pre-release, or pin an exact version
like `@eduardorenani/atlasjs@0.1.0-alpha.0` for reproducible installs. Spec
[`007`](specs/007-release-and-distribution.md) §D5 has the dist-tag policy.

## 10. Where to look when something breaks

| Symptom                                                    | Where to look                                                       |
| ---------------------------------------------------------- | ------------------------------------------------------------------- |
| "Type 'X' is not assignable to type 'never'" on `context`  | `JsonCompatible` rejecting a non-JSON shape (Date/Map/Set/function/method). See spec 005 §P5. |
| "`routes` is missing required property 'retry'"            | Add `retry: []` (no-op) or a `RetryEntry`. All three outcomes are mandatory. |
| "Type 'string' is not assignable to type 'never'" on `target` | Sibling name doesn't exist in the immediate enclosing `modes` map. Wrapper validates at compile + runtime. |
| Promise rejected and the actor died                         | No `routes.error` declared — rejection re-thrown above the actor by design. Add `routes.error` if you want to catch it. |
| Action callback typed as `unknown` event                    | `defineAgent.actions[*].event` is the full `TEvents` union. Narrow inside the body via `event.type === "..."`. |

## 11. Further reading

- **Source-of-truth types**: [`packages/atlas/src/types.ts`](../packages/atlas/src/types.ts)
- **Worked example** (CLI agent in Portuguese): [`examples/zoe/`](../examples/zoe)
- **API contract spec**: [`docs/specs/004-xstate-agent-wrapper.md`](specs/004-xstate-agent-wrapper.md)
- **Deps + JSON-safe context spec**: [`docs/specs/005-agent-deps-and-stringifiable-context.md`](specs/005-agent-deps-and-stringifiable-context.md)
- **`states` → `modes` vocabulary spec**: [`docs/specs/006-modes-not-states.md`](specs/006-modes-not-states.md)
- **Release & distribution spec**: [`docs/specs/007-release-and-distribution.md`](specs/007-release-and-distribution.md)
- **`startAgent` + snapshot rehydration spec**: [`docs/specs/009-snapshot-aware-rehydration.md`](specs/009-snapshot-aware-rehydration.md)
- **Host-side error channel spec**: [`docs/specs/010-error-channel.md`](specs/010-error-channel.md)
- **Design decisions log**: [`docs/design-decisions.md`](design-decisions.md)
