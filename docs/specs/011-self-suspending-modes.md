# 011 — Unified Modes (active/passive, `outcome`/`stay`)

## Status

Draft.

> This draft supersedes an earlier direction in this same file (a `suspend`
> outcome that paired a leaf with a synthetic wait-state). The debate moved
> past it: instead of adding one outcome, this spec **unifies the `Mode`
> primitive** so the passive/active split stops being two mutually-exclusive
> *types* and becomes a single mode with one activation **bit**. The shape
> below is validated end-to-end (type-checks under `--strict`) in the
> prototype `temp-diagrams/011-self-suspending-modes.proto.ts`. Names are
> working names; open points are in `## Clarifications`.

## Goal

Collapse the passive/active distinction into **one `Mode`**. A mode always has
a `behavior`; how it is *activated* is a single field (`start`), and what the
`behavior` does next is a single return value with two natures: **leave** the
mode (`outcome`) or **stay** in it (`stay`). This removes the forced
`compound(listening + working)` pattern: one mode can do work *and* wait for
events, as **temporally ordered phases** (never concurrently).

## Motivation / Problems Addressed

### P15 — A chatbot turn forces a compound `listening` + `working` per mode

In a chatbot, almost every conversational mode is a `CompoundMode` pairing a
passive leaf (waiting for the user's message) with one or more active leaves
(processing it). Zoe is exactly this: `socratic` = `teaching` (active) +
`listening` (passive) + `evaluating` (active) (`examples/zoe/src/states/socratic.ts`).
Running the **same** behavior again after a fresh message forces the path
`working A → listening → (A or B)`, because waiting and working are, by
construction, different node *kinds*:

- active leaf → XState `invoke` (`packages/atlas/src/buildActiveState.ts:113-120`);
- passive leaf → atomic state with `on` (`packages/atlas/src/buildPassiveState.ts:43-45`);
- mutually exclusive at the type level (`ModeConfig = ActiveModeConfig |
  PassiveModeConfig`, `types.ts:473-480`; **DD-019**: mixing `behavior` and `on`
  is a compile error) and at compile dispatch (`compile.ts:530-541`).

### P16 — A shared passive `listening` node loses origin

The compiler happily lowers N active leaves in one compound, and active→active
routing already works (`socratic.evaluating` routes `achieved → "teaching"` with
no listening hop, `examples/zoe/src/states/socratic.evaluating.ts:80-84`). The
real wall: a passive leaf routes purely on `event.type` with **no memory of
which mode preceded it** (`socratic.listening.ts:9-13`). So *work → wait for a
new message → resume the specific work* cannot resume "the working mode I came
from" without threading a `returnTo` discriminator through context.

### P17 — The passive/active *type* split is the root cause

P15/P16 are symptoms. The root is that "waits" and "acts" are two **types** with
incompatible surfaces (`on` vs `behavior`/`routes`). A single mode that both
acts and (afterwards) waits is unrepresentable. This spec removes the split
itself — see "Why this is safe" for why the unification does **not**
reintroduce the concurrency hazard that killed an earlier naive attempt.

## The model

A single `defineMode`. No more `on`-only passive leaves; every mode has a
`behavior`. Two things are configurable beyond the behavior:

1. **`start`** — *how the mode is activated* (one bit):
   - **`run`** (default) — *behavior-driven*. Entering the mode runs the
     behavior immediately (a "dry run", `event: undefined`).
   - **`event`** — *event-driven*. Entering the mode **parks**; the behavior
     runs only when a declared event arrives.
2. The **behavior's return value** — two natures (mutually exclusive):
   - **`{ outcome }`** — *leave* the mode. `"achieved"` (goal met) or
     `"abandoned"` (gave up). Dispatched by `routes` (each carries a `target`).
   - **`{ stay }`** — *remain* in the mode and re-run the behavior. `"replay"`
     (re-run now) or `"waitOnEvent"` (re-run on the next declared event).
     Dispatched by `stay` (no `target`).

### What `event` a re-run carries (and the only type difference)

`replay` re-runs immediately; `waitOnEvent` re-runs on the **next** event. What
the re-run *carries* depends on `start`, and that is the **only** type
difference between run and event:

| `start` | entry | `replay` re-runs with | `event` type in `behavior` |
| --- | --- | --- | --- |
| `run` | dry run (`event: undefined`) | **no** event (`undefined`) | `Ev \| undefined` |
| `event` | parks (no run) | the **same** event | `Ev` (never undefined — no guard) |

Rationale: `run` is behavior-driven, so its `replay` is the classic
self-loop with no event (like today's `retry`, DD-014). `event` is
event-driven — every run is *about* an event, so `replay` keeps the **same**
event and `waitOnEvent` swaps it for the next one; the behavior therefore never
sees `undefined`, and the `event` narrows to `Ev` with no guard.

### Surface (TypeScript)

```ts
type Outcome = "achieved" | "abandoned";
type Stay    = "replay" | "waitOnEvent";

// the behavior speaks ONLY through this return value (strict boundary).
// XOR via `never`: the two natures cannot be mixed in one result.
type ModeResult<Pay> =
    | { outcome: Outcome; stay?: never; payload: Pay }   // LEAVE
    | { stay: Stay; outcome?: never; payload: Pay };     // STAY

// one assign shape, used by exits AND continuations
type Assign<Ctx, Pay, D> = (a: { context: Ctx; payload: Pay; deps: D }) => Partial<Ctx>;

type CommonConfig<Ctx, Ev extends { type: string }, Pay, D> = {
    input:   (a: { context: Ctx; deps: D }) => unknown;
    events?: readonly Ev["type"][];                      // event types the mode may wait/replay on
    routes: {                                            // EXITS — each carries a target
        achieved:  { target: string | END; assign?: Assign<Ctx, Pay, D> };
        abandoned: { target: string | END; assign?: Assign<Ctx, Pay, D> };
    };
    stay?: {                                             // CONTINUATIONS — no target, same assign
        replay?:      { assign?: Assign<Ctx, Pay, D> };
        waitOnEvent?: { assign?: Assign<Ctx, Pay, D> };
    };
};

// the kinds differ ONLY in the behavior's `event` type
type RunModeConfig<Ctx, Ev, Pay, D>  = CommonConfig<Ctx, Ev, Pay, D> & {
    start?: "run";
    behavior: (a: { input: unknown; event: Ev | undefined; deps: D }) => Promise<ModeResult<Pay>>;
};
type EventModeConfig<Ctx, Ev, Pay, D> = CommonConfig<Ctx, Ev, Pay, D> & {
    start: "event";
    behavior: (a: { input: unknown; event: Ev; deps: D }) => Promise<ModeResult<Pay>>;
};

// ONE constructor, two overloads discriminated by `start` (event first — more specific)
declare function defineMode<Ctx, Ev extends { type: string }, Pay, D>(c: EventModeConfig<Ctx, Ev, Pay, D>): Mode<Ctx, Ev, Pay, D>;
declare function defineMode<Ctx, Ev extends { type: string }, Pay, D>(c: RunModeConfig<Ctx, Ev, Pay, D>):  Mode<Ctx, Ev, Pay, D>;
```

### Runtime cycle

```
enter
 ├─ start:"event" ─► park ──┐
 └─ start:"run"  ─► run behavior (event: undefined)
                              │
              ┌───────────────┴──────────── behavior result ────────────────┐
              ▼                              ▼                               ▼
        { outcome }                    { stay:"replay" }              { stay:"waitOnEvent" }
        routes[outcome].assign         stay.replay.assign             stay.waitOnEvent.assign
        ─► target (LEAVE)              ─► re-run NOW                  ─► park, re-run on NEXT event
                                          (run: no event;            (event becomes the behavior's
                                           event: same event)          `event` on the next run)
```

## Examples

Active mode — the whole `socratic` compound collapsed into one mode (teaches on
entry, `replay`s to re-teach, `waitOnEvent` for the reply):

```ts
const socratic = defineMode<SocraticContext, AgentEvents, SocraticPayload, Deps>({
    input: ({ context }) => ({ messages: context.messages, evalRetries: context.evalRetries }),
    events: ["MESSAGE"],
    behavior: async ({ input, event, deps }) => {
        const { messages, evalRetries } = input as { messages: Message[]; evalRetries: number };
        if (event?.type === "MESSAGE") {                          // run: event is Ev | undefined -> narrow
            const withReply = [...messages, { role: "user" as const, content: event.text }];
            const judgment = await deps.evaluate(withReply);
            if (judgment === "understood") return { outcome: "achieved",  payload: { messages: withReply } };
            if (judgment === "abandoned" || evalRetries >= 3) return { outcome: "abandoned", payload: { messages: withReply } };
            return { stay: "replay", payload: { messages: withReply } };       // not understood -> replay (no event) -> re-teach
        }
        const taught = await deps.teach(messages);
        return { stay: "waitOnEvent", payload: { messages: taught } };          // taught -> wait for the reply
    },
    routes: {
        achieved:  { target: END, assign: ({ payload }) => ({ messages: payload.messages }) },
        abandoned: { target: END, assign: ({ payload }) => ({ messages: payload.messages }) },
    },
    stay: {
        replay:      { assign: ({ context, payload }) => ({ messages: payload.messages, evalRetries: context.evalRetries + 1 }) },
        waitOnEvent: { assign: ({ payload }) => ({ messages: payload.messages }) },
    },
});
```

Passive mode — the root `idle`/`listening`: parks on entry, runs only on a
`MESSAGE`, `event` is `Ev` (no guard):

```ts
const idle = defineMode<IdleContext, AgentEvents, IdlePayload, Deps>({
    start: "event",
    events: ["MESSAGE"],
    input: ({ context }) => ({ messages: context.messages }),
    behavior: async ({ input, event }) => {                       // event: AgentEvents — never undefined
        const { messages } = input as { messages: Message[] };
        return { outcome: "achieved", payload: { messages: [...messages, { role: "user", content: event.text }] } };
    },
    routes: {
        achieved:  { target: "classifying", assign: ({ payload }) => ({ messages: payload.messages }) },
        abandoned: { target: END },
    },
});
```

## Design decisions

- **DD-026 (proposed) — Unify the mode primitive; `start` replaces the
  passive/active *type* split.** This **revokes DD-019** (the
  `RunModeConfig | EventModeConfig` mutual exclusion). Passive and active
  are no longer two surfaces; they are one surface with an activation bit. Both
  always have a `behavior`.
- **DD-027 (proposed) — The behavior's result has two natures: `outcome`
  (leave) XOR `stay` (continue).** `achieved`/`abandoned` are judgements on the
  goal (they carry a `target`); `replay`/`waitOnEvent` are continuations (no
  target). They are *not* four flat outcomes — a plain key-presence union does
  not stop mixing them, so the result type uses `never` on the opposite
  discriminant to forbid `{ outcome, stay }` (verified empirically).
- **DD-028 (proposed) — `routes` holds only exits; `stay` holds continuations.**
  `routes` regains its honest meaning (everything in it has a `target`).
  `retry`/`wait` never belonged under a "routes" key.
- **`assign` is uniform.** Exits and continuations use the same
  `({ context, payload, deps }) => Partial<Ctx>` shape. The behavior returns
  pure `payload`; `assign` (declarative) maps it to context — no `set:`-style
  patch in the behavior.
- **`event` narrowing is manual; type args stay explicit.** The behavior gets
  `event: Ev` (event) or `Ev | undefined` (run) and narrows with
  `event.type`, exactly like XState v5. We measured that auto-narrowing the
  `event` subset from a field requires fully-inferred or curried type args
  (S2/S4 in the prototype notes); with explicit type args it silently falls to
  the default. Manual narrowing avoids that fragility.
- **`start`, not "born passive".** "Born passive" implied a one-time
  initialization; activation is a *permanent* property of the mode (it governs
  every entry), so it is a `start`, not an `entry` flag.
- **No tools/objective in the lib.** The SDK-goal notions of *objective* and
  *tools* live in `deps` and in the behavior's own code; the library models
  orchestration (activation, exits, continuations, transitions), not how the
  behavior does its work.

## Why this is safe (vs. the naive unification we rejected)

An earlier idea — one node that runs a `behavior` **and** carries `on`
handlers *concurrently* — was rejected because an event arriving mid-`behavior`
would cancel the in-flight `fromPromise` actor (`buildActors.ts:48`, which does
not even thread XState's abort `signal`), silently discarding the outcome and
breaking "`achieved` is the only way out, no untyped escape hatch".

This design avoids that entirely: a mode is **either** running its behavior
**or** parked waiting — never both at once. Work and wait are **temporally
ordered phases** selected by the behavior's own return (`stay: "waitOnEvent"`),
not two concurrent exit surfaces. The "waiting XOR working" invariant is
preserved; it just moves from "two node types" to "two phases of one mode".

## Desugaring (to XState) — DD-029 (proposed): a mode is a mini-compound

A self-suspending mode lowers to a **compound XState state** with two synthetic
substates (`$run`, `$wait`), reusing the existing compound + `injectEnd`
pipeline. The mode stays uniform externally (`foo` is always the mode; entry is
via its `initial`; siblings target `foo`):

```
foo: {
    initial: "$run"  (run)  |  "$wait"  (event),
    states: {
        $run: {
            invoke: {
                src: actorName(foo),
                input: ({ context }) => ({ userInput, event: context[$event] }),
                onDone: [
                    // achieved/abandoned → END sentinel → injectEnd → $end_<bucket> final
                    // stay:"replay"      → { target: "$run", reenter: true }  (run clears $event; event keeps it)
                    // stay:"waitOnEvent" → { target: "$wait" }
                ],
                onError: [ ... ],
            },
        },
        $wait: { on: { <events>: { target: "$run", actions: <save event to $event slot>, reenter: true } } },
        // $end_achieved / $end_abandoned: { type: "final", output }  ← injected by injectEnd
    },
    onDone: [ achieved → route target, abandoned → route target ],   // the mode's `routes`
}
```

- **`behavior`** → `$run.invoke` (`fromPromise`). Its `input` reads the waking
  event from an internal context slot and passes it to the behavior alongside
  `userInput` (`buildActiveState.ts:341-344` currently builds `({ context }) => …`).
- **`outcome: achieved/abandoned`** → `$run.invoke.onDone[i]` targeting the END
  sentinel; `injectEnd` rewrites to a `$end_<bucket>` final and `foo.onDone`
  routes to the sibling — identical to a compound today.
- **`stay: "replay"`** → `$run.invoke.onDone[i]` self-loop
  `{ target: "$run", reenter: true }` (the old `buildRetryTransition`,
  `buildActiveState.ts:222-226`). **run** clears the `$event` slot (no event);
  **event** keeps it (same event).
- **`stay: "waitOnEvent"`** → `$run.invoke.onDone[i]` `{ target: "$wait" }`.
- **`$wait`** receives a declared event → an action saves it to the `$event`
  slot and re-enters `$run`.
- **`start: "event"`** → `initial: "$wait"` (parks); **run** → `initial: "$run"`.

The `$event` slot is an internal context key written on the `$wait → $run`
transition and read by `$run.invoke.input`. It is part of the snapshot (spec
009), so the waking event must be JSON-serializable; the synthetic `foo.$run` /
`foo.$wait` paths and the internal `$run ↔ $wait` transitions are masked from
`inspect`/snapshot (Clarifications #5/#6). A mode with no `stay`/`events` (a pure
exit) need not be wrapped — it can stay a plain leaf.

## Proposed behavior change (bullets)

- One `defineMode`; `start: "run" | "passive"` is a single activation bit
  (DD-026, revoking DD-019). Every mode has a `behavior`.
- Behavior returns `{ outcome: "achieved" | "abandoned" }` (leave) **xor**
  `{ stay: "replay" | "waitOnEvent" }` (stay) (DD-027).
- `routes` holds the two exits (target + assign); `stay` holds the two
  continuations (assign only) (DD-028).
- `replay` re-runs now (run: no event; event: same event); `waitOnEvent`
  re-runs on the next event. `event` is `Ev` (event) / `Ev | undefined`
  (run).
- Pure phased sugar — desugars to an `invoke` plus a synthetic wait sibling; no
  concurrency introduced.

## Clarifications

1. **Naming (working names).** `start: "run" | "passive"`; continuations
   `replay` / `waitOnEvent`. `replay` is one word while `waitOnEvent` is
   camelCase-composite — a symmetric pair (`replay`/`awaitEvent`, or
   `replayNow`/`waitOnEvent`) is still open. `start` could be `activation` /
   `trigger: "behavior" | "event"`.
2. **Cardinality of `waitOnEvent`.** One wait surface per mode (the mode's
   `events`). If a mode must wait for *different* event sets at different points
   (e.g. `CONFIRM` then `PAYMENT_RESULT`), do we add named wait phases, or does
   the behavior accept the union and branch? Deferred — start with one set.
3. **Passive `event` typing under explicit type args.** The overloads give
   `passive → event: Ev` and `active → event: Ev | undefined` (verified). This
   relies on `start` discriminating the overload; confirm it holds when `Ctx`
   needs to stay an explicit type arg (it does in the prototype).
4. **Type-safe `stay` vs `events`.** Returning `{ stay: "waitOnEvent" }` from a
   mode that declared no `events` should ideally be a compile error. Mechanism
   TBD (condition the result type on `events`/`stay` presence).
5. **Synthetic node naming & snapshots (spec 009).** `mode$wait` must have a
   **deterministic, version-stable** name — a snapshot persisted while parked
   points at it, so renaming/reordering siblings must not move the name and
   break rehydration. `pickEndName` is deterministic given the sibling set;
   confirm it suffices.
6. **Observability (spec 009). — RESOLVED.** A self-suspending mode lowers to a
   mini-compound whose synthetic substates (`$run`/`$wait`/`$end_*`) the author
   never wrote. **Decision: do BOTH.**
   - **Mask** the synthetic paths in `inspect.transition` (and `onError`): a
     parked mode reports `to: "mode"`, not `to: "mode.$wait"`; a running one
     `to: "mode"`, not `to: "mode.$run"`. Implemented in `formatModePath`: when
     the single child value is a string starting with `$`, drop the synthetic
     segment. Real nested compounds (non-`$` children) recurse unchanged.
   - **Expose readiness explicitly** via a new `awaiting?: readonly string[]`
     field on `AgentInspectionEvent`. Present and non-empty ONLY when parked in
     `$wait`, listing the event types that resume the mode; absent while running
     in `$run`. Since masking removes "parked vs running" from the path, hosts
     read readiness from `awaiting` instead of matching a `.$wait` suffix.
     `buildWaitState` stamps the waited-on events onto the `$wait` state's
     `meta.atlasAwaiting`; the inspect adapter recovers them via
     `snapshot.getMeta()` (XState v5 snapshots do not expose `nextEvents`).
7. **`abandoned` is required (SDK-goal "never stuck").** Keep `abandoned`
   mandatory in `routes` (as `routes.abandoned` is today, `types.ts:322-324`) so
   every mode always has a give-up exit.
8. **`error` channel.** This draft omits the synthesized `error` path that
   active leaves have today (`routes.error`, spec 010 `onError`). Decide whether
   the unified mode keeps a `routes.error` bucket or relies solely on host-side
   `onError`. Likely keep both, unchanged.

> Visual review scaffolding (the Mermaid C4 dynamic diagram of the runtime
> flow, per the SDD loop) is deferred to the implementation pass. The
> type-level prototype lives at
> `temp-diagrams/011-self-suspending-modes.proto.ts` and type-checks under
> `--strict`.
