# @eduardorenani/atlasjs — Usage

> Companion to [`packages/atlas/README.md`](../packages/atlas/README.md). This
> page is the working-developer reference: install, define modes, compose them
> into an agent, and run it. The exhaustive type contract lives in
> [`packages/atlas/src/types.ts`](../packages/atlas/src/types.ts); the
> rationale for each shape lives in
> [`docs/specs/004-xstate-agent-wrapper.md`](specs/004-xstate-agent-wrapper.md),
> [`005`](specs/005-agent-deps-and-stringifiable-context.md), and
> [`006`](specs/006-modes-not-states.md).

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
  XState v5 machine ready for `createActor`.

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
import { defineAgent } from "@eduardorenani/atlasjs";
import { createActor } from "xstate";

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

const actor = createActor(machine).start();
actor.send({ type: "ASK", question: "What is a mode?" });
```

`defineAgent` returns the compiled XState machine. From here every XState v5
runtime API works: `createActor`, `subscribe`, `getSnapshot`, snapshot
persistence, `@xstate/inspect`, etc.

## 6. Deps & JSON-safe context

- **`deps`** — a frozen, JSON-incompatible (functions allowed!) container of
  external resources. Forwarded to every `input` / `behavior` / `assign` /
  `guard`. Defaults to `{}` when omitted; user code receives `Readonly<TDeps>`.
- **`context`** — root and compound-local context is structurally constrained
  to `JsonCompatible<T>`. The compiler rejects `Date`, `Map`, `Set`, functions,
  and class instances with methods. The point is snapshot round-trip — what
  goes into `JSON.stringify(actor.getPersistedSnapshot())` must come back the
  same shape on rehydrate. Spec 005 §P5.

## 7. What you do not do

- **No raw XState configs in `modes` slots.** Only `defineMode` /
  `defineCompoundMode` outputs are accepted. The brand on the slot type
  enforces this at compile time.
- **No active+passive mix.** A single leaf is either active (`{ input,
  behavior, routes }`) or passive (`{ on }`). Mixing keys is a compile error.
- **No silent error swallow.** Omit `routes.error` and rejections rethrow
  above the actor. The shorthand "I'll deal with it later" doesn't exist.
- **No inline callbacks in passive `on`.** Use named `actions` on
  `defineAgent`.

## 8. Versioning & install pins

The library is alpha. Pre-1.0 versions publish under the `alpha` dist-tag —
`npm install @eduardorenani/atlasjs` without a tag will fail to resolve (no `latest` yet).
Use `@eduardorenani/atlasjs@alpha` to track the latest pre-release, or pin an exact version
like `@eduardorenani/atlasjs@0.1.0-alpha.0` for reproducible installs. Spec
[`007`](specs/007-release-and-distribution.md) §D5 has the dist-tag policy.

## 9. Where to look when something breaks

| Symptom                                                    | Where to look                                                       |
| ---------------------------------------------------------- | ------------------------------------------------------------------- |
| "Type 'X' is not assignable to type 'never'" on `context`  | `JsonCompatible` rejecting a non-JSON shape (Date/Map/Set/function/method). See spec 005 §P5. |
| "`routes` is missing required property 'retry'"            | Add `retry: []` (no-op) or a `RetryEntry`. All three outcomes are mandatory. |
| "Type 'string' is not assignable to type 'never'" on `target` | Sibling name doesn't exist in the immediate enclosing `modes` map. Wrapper validates at compile + runtime. |
| Promise rejected and the actor died                         | No `routes.error` declared — rejection re-thrown above the actor by design. Add `routes.error` if you want to catch it. |
| Action callback typed as `unknown` event                    | `defineAgent.actions[*].event` is the full `TEvents` union. Narrow inside the body via `event.type === "..."`. |

## 10. Further reading

- **Source-of-truth types**: [`packages/atlas/src/types.ts`](../packages/atlas/src/types.ts)
- **Worked example** (CLI agent in Portuguese): [`examples/zoe/`](../examples/zoe)
- **API contract spec**: [`docs/specs/004-xstate-agent-wrapper.md`](specs/004-xstate-agent-wrapper.md)
- **Deps + JSON-safe context spec**: [`docs/specs/005-agent-deps-and-stringifiable-context.md`](specs/005-agent-deps-and-stringifiable-context.md)
- **`states` → `modes` vocabulary spec**: [`docs/specs/006-modes-not-states.md`](specs/006-modes-not-states.md)
- **Release & distribution spec**: [`docs/specs/007-release-and-distribution.md`](specs/007-release-and-distribution.md)
- **Design decisions log**: [`docs/design-decisions.md`](design-decisions.md)
