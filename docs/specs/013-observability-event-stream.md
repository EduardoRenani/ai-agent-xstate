# 013 — Observability Event Stream (`onEvent`)

## Status

Completed.

## What changes (behavior bullets)

- New construction-time callback `startAgent(agent, { onEvent })` receiving a
  **single discriminated-union stream** of Atlas-vocabulary lifecycle events.
- New event kinds beyond `transition` (**7 in v1**): `mode.entered`,
  `mode.run.started`, `mode.run.settled` (with `outcome` + `payload` +
  `durationMs`), `mode.stayed`, `mode.parked`, `mode.exited`, `error.escaped`.
  `error.recovered` is **deferred to v2** (C7).
- v1 scope trims (feasibility, lockstep with code): `mode.run.started` carries
  no `input` (not observable from the snapshot stream — v2), and `mode.exited`
  carries no `outcome` (it's on the preceding `mode.run.settled`).
- All derived from the single `@xstate.snapshot` stream; verified end-to-end by
  `test/spec013-observability.test.ts`.
- Every event carries a **shared envelope**: monotonic `seq`, wall-clock `at`,
  `modePath`, and an optional host `correlationId`.
- The triggering/waking event (`trigger`) is exposed on the events that have a
  cause — the host can finally log *why* a transition happened.
- `context` delivered to observers is **sanitized**: the synthetic `$event` and
  `__<path>_local` slots never appear.
- True escapes emit `error.escaped` (the spec 010 channel, now part of the
  unified stream). Recovered errors remain silent in v1 — `error.recovered` is
  deferred to v2 (C7).
- `inspect` and `onError` (specs 009/010) are retained as **legacy aliases**
  derivable from the new stream (deprecation TBD — see Clarifications C1).

## Goal

Give a host **one ergonomic callback** that receives every observable thing the
agent does, with enough context to write a log/metric/span line **without**
threading correlation by hand, parsing internal state, or wiring multiple
channels. After this spec:

```ts
startAgent(agent, {
    correlationId: req.id,
    onEvent: (e) => logger.info({ kind: e.kind, mode: e.modePath, trace: e.correlationId }),
});
```

…is the complete observability setup. Logging is the **primary** use case this
spec optimizes for; metrics and tracing fall out of the same stream.

## Problems Addressed

The current surface (`inspect` + `onError`, specs 009/010) has these ergonomic
gaps for a host that wants to log agent activity:

### P1 — Only one event kind

`AgentInspectionEvent` (`packages/atlas/src/types.ts:784`) is just
`type: "transition"`. The data a logger wants — which **outcome** a mode
produced, its **payload**, how **long** the behavior ran, whether it
**replayed** — exists inside the engine (`readDoneOutput`,
`xstateBackend.ts:89`) but never reaches the host.

### P2 — Recovered errors are invisible

`onError` only fires on **escape** (`types.ts:837`). An error handled by
`routes.error` emits nothing, so "mode X failed but recovered to Y" — the most
interesting resilience signal — cannot be logged. **v1 only closes the escape
half (`error.escaped`); the recovered half (`error.recovered`) is deferred to
v2 (C7).**

### P3 — No causation, no correlation, no timing

`transition` has no triggering event, no timestamp, no duration, and no
trace/turn id. Today the host threads its own `sessionId` manually into every
log call (`examples/zoe/src/turn.ts:83`). Every adopter re-implements this.

### P4 — Internal slots leak into `context`

The root context carries synthetic keys `$event` (`eventSlot.ts:14`) and
`__<path>_local` (`contextLift.ts:8`). `inspect` hands `snap.context` raw
(`startAgent.ts:124`), so a host logging `e.context` sees Atlas/XState
internals — contradicting the "no engine leak" rule in `CLAUDE.md`.

### P5 — Dedup hides work

`startAgent.ts:133` suppresses an event when masked path + readiness are
unchanged, so a `replay` self-loop (re-running the same mode) produces no
signal — invisible retries.

## Public API Changes

### `StartAgentOptions` — new `onEvent` + `correlationId`

```ts
export type StartAgentOptions<TContext> = {
    snapshot?: AgentSnapshot<TContext>;

    /**
     * Host correlation id, stamped onto every emitted event's envelope.
     * Removes the manual session-id threading hosts do today.
     */
    correlationId?: string;

    /**
     * The unified observability stream. Receives one discriminated-union
     * event per observable agent action, in Atlas vocabulary. Synchronous;
     * keep it cheap (offload heavy work to your logger/exporter).
     */
    onEvent?: (event: AgentEvent<TContext>) => void;

    // ── Deprecated (specs 009/010). Reimplemented internally on top of the
    //    `onEvent` stream; kept working until a later major (C1). ──
    /** @deprecated Use `onEvent` and switch on `mode.*` kinds. */
    inspect?: (event: AgentInspectionEvent<TContext>) => void;
    /** @deprecated Use `onEvent` and handle `kind: "error.escaped"`. */
    onError?: (info: AgentErrorInfo<TContext>) => void;
};
```

### The event envelope

Every event shares this shape, so a logger can build a base record once:

```ts
export type AgentEventEnvelope = {
    /** Monotonic per-actor counter, starting at 0. Orders events absolutely. */
    seq: number;
    /** Wall-clock ms (Date.now) when Atlas emitted the event. */
    at: number;
    /** Dot-joined mode-path the event concerns. Synthetic `$run`/`$wait`
     *  substates are masked, exactly like `inspect.to` today. */
    modePath: string;
    /** Echo of `StartAgentOptions.correlationId`, if the host set one. */
    correlationId?: string;
};
```

### The event union

```ts
/** All observable agent lifecycle events, in Atlas vocabulary. */
export type AgentEvent<TContext> =
    | (AgentEventEnvelope & {
          kind: "mode.entered";
          /** The event that drove entry, if any (absent on the initial mode). */
          trigger?: { type: string };
          /** Sanitized root context after entry assigns ran. */
          context: TContext;
      })
    | (AgentEventEnvelope & {
          kind: "mode.run.started";
          // NOTE (v1): the derived `input(...)` is NOT exposed — it is computed
          // inside the engine (`buildRunInput`) and not observable from the
          // inspection stream. Deferred to v2 (same class as `error.recovered`).
          /** The waking event, when the run resumed a parked mode. */
          trigger?: { type: string };
          context: TContext;
      })
    | (AgentEventEnvelope & {
          kind: "mode.run.settled";
          /** Which bucket the behavior resolved into. */
          outcome: "achieved" | "abandoned" | "error";
          /** The `ModeResult.payload` (or raw error for `outcome:"error"`). */
          payload: unknown;
          /** ms between this mode's `mode.run.started` and settlement. */
          durationMs: number;
          context: TContext;
      })
    | (AgentEventEnvelope & {
          kind: "mode.stayed";
          /** A self-continuation: re-run now (`replay`) or wait (`waitOnEvent`). */
          stay: "replay" | "waitOnEvent";
          context: TContext;
      })
    | (AgentEventEnvelope & {
          kind: "mode.parked";
          /** Non-empty list of event types that will resume the mode. */
          awaiting: readonly string[];
          context: TContext;
      })
    | (AgentEventEnvelope & {
          kind: "mode.exited";
          /** Mode-path the agent moved to. The outcome that caused the exit is
           *  on the preceding `mode.run.settled` for the same mode. */
          to: string;
          context: TContext;
      })
    | (AgentEventEnvelope & {
          kind: "error.escaped";
          /** Raw rejection value that escaped declarative recovery. */
          error: unknown;
          /** Snapshot at the moment of escape (same as `AgentErrorInfo`). */
          snapshot: AgentSnapshot<TContext>;
          context: TContext;
      });
```

## Ergonomic usage (the point of this spec)

### 1. Quick console trace

```ts
startAgent(agent, {
    correlationId: sessionId,
    onEvent: (e) => console.log(`#${e.seq} ${e.kind} @ ${e.modePath}`),
});
```

### 2. Structured logger (pino/winston) — switch on `kind`

The envelope gives a reusable base; the host logs only what each kind adds. No
manual session threading, no `e.context` parsing for internal keys.

```ts
startAgent(agent, {
    correlationId: req.id,
    onEvent: (e) => {
        const base = { seq: e.seq, mode: e.modePath, trace: e.correlationId };
        switch (e.kind) {
            case "mode.run.settled":
                logger.info({ ...base, outcome: e.outcome, ms: e.durationMs }, "mode settled");
                break;
            case "error.recovered":
                logger.warn({ ...base, err: e.error, to: e.recoveredTo }, "mode recovered");
                break;
            case "error.escaped":
                logger.error({ ...base, err: e.error }, "mode escaped");
                break;
            default:
                logger.debug(base, e.kind);
        }
    },
});
```

### 3. OpenTelemetry spans — pair start/settle by `modePath`

`mode.run.started` and `mode.run.settled` bracket a behavior; `durationMs`
removes the need to time it yourself.

```ts
const spans = new Map<string, Span>();
startAgent(agent, {
    onEvent: (e) => {
        if (e.kind === "mode.run.started") {
            spans.set(e.modePath, tracer.startSpan(`mode:${e.modePath}`));
        } else if (e.kind === "mode.run.settled") {
            const span = spans.get(e.modePath);
            span?.setAttribute("atlas.outcome", e.outcome);
            span?.end();
            spans.delete(e.modePath);
        }
    },
});
```

### 4. Readiness gate collapses to one line

The host pattern that today reads `awaiting` off `inspect`
(`examples/zoe/src/turn.ts:65`) becomes:

```ts
onEvent: (e) => { if (e.kind === "mode.parked") resolveReady(); },
```

## Behavior Contract

- **Additive.** When `onEvent` is omitted, no extra work and no `subscribe`
  beyond what `inspect`/`onError` already trigger (preserves spec 010's
  strict-additive guarantee).
- **Synchronous, ordered.** Events fire in `seq` order, synchronously inside
  the engine step that produced them. `seq` is per-actor and starts at 0.
- **Sanitized context.** Every `context` field has `$event` and every
  `__<path>_local` slot stripped (fixes P4). The sanitization is read-only —
  it does not alter the live context or the persisted snapshot.
- **`correlationId` is opaque.** Atlas only echoes it; it never inspects it.
- **`at` via `Date.now()`** (C3), stamped at emit time.
- **Payloads by reference, read-only** (C8). `payload`/`error`/`trigger`/
  `context` are live references; observers must not mutate them. Clone host-side
  if you need to retain or serialize.

## Mapping (event → engine signal)

Conceptual mapping onto the current backend; the adapter lives in
`startAgent.ts` (the only place already allowed to read raw inspection events).

| Event | Derived from |
| --- | --- |
| `mode.entered` | `@xstate.snapshot` where masked path entered a new mode |
| `mode.run.started` | `@xstate.snapshot` whose raw leaf is `$run` (a fresh run: mode change, or replay re-entry detected via `output.stay === "replay"`); `trigger` from `snap.event` when it is a user event. (`input` deferred to v2.) |
| `mode.run.settled` | `@xstate.snapshot` whose `snap.event.type` is `xstate.done.actor.*`; `outcome`+`payload` from `event.output` via `readDoneOutput` (`xstateBackend.ts:89`); `durationMs` = `at` − the recorded `run.started.at` for the running mode |
| `mode.stayed` | as `run.settled` but `output.stay` is set (`makeStayGuard`, `xstateBackend.ts:398`) |
| `mode.parked` | `@xstate.snapshot` active leaf is a `$wait`; `awaiting` from `meta.atlasAwaiting` (`readAwaiting`, `startAgent.ts:192`) |
| `mode.exited` | `@xstate.snapshot` masked path left a mode |
| `error.escaped` | the existing `subscribe.error` path (spec 010) |

> `error.recovered` is **not emitted in v1** (C7, deferred to v2). Errors handled
> by `routes.error` stay silent for now; only escapes surface.

## Relationship to `inspect` / `onError`

`onEvent` is a superset:

- `inspect.transition` ≈ `mode.entered` + `mode.parked` + `mode.exited`.
- `onError(info)` ≈ `error.escaped` (`info.snapshot`/`modePath`/`error` map 1:1).

Both legacy callbacks are **soft-deprecated** as of this spec (C1): marked
`@deprecated`, reimplemented internally as thin `onEvent`-derived adapters (one
source of truth), kept working until a later major.

## Clarifications

- **C1 — Deprecate `inspect`/`onError`, or keep both indefinitely?** `onEvent`
  can express both. Options: (a) keep all three forever; (b) soft-deprecate
  `inspect`/`onError` in docs now, remove in a later major; (c) implement
  `inspect`/`onError` internally as thin `onEvent` adapters. **RESOLVED:
  deprecate.** `inspect`/`onError` are soft-deprecated (JSDoc `@deprecated` +
  docs) as of this spec and removed in a later major; v1 keeps them working,
  reimplemented internally as thin `onEvent`-derived adapters so there is one
  source of truth.
- **C2 — Event granularity. RESOLVED: Level C (the full 8-kind set above).**
  The host wants fine-grained tracing — `mode.run.started` distinct from
  `mode.entered`, and `mode.stayed` for replay/waitOnEvent visibility. A
  tool-call kind remains a future, additive extension (out of scope for v1).
  This decision makes C6 and C7 load-bearing (the fine kinds are exactly the
  ones with implementation risk).
- **C3 — Timestamp source. RESOLVED: `Date.now()`.** `at` is stamped by Atlas
  via `Date.now()` at emit time. Simplicity over deterministic-test purity;
  tests that need a fixed clock assert on `seq`/`kind`/`modePath`, not `at`.
- **C4 — `durationMs` correctness across persistence. RESOLVED: single boot.**
  `durationMs` measures only the active `$run` wall-time within one `startAgent`
  boot. A mode that parks and resumes across boots does not accumulate the
  parked gap; cross-boot timing is out of scope (would need the start time
  persisted in the snapshot).
- **C5 — Multi-observer. RESOLVED: single `onEvent`.** One callback; hosts that
  want fan-out (logger + metrics + tracer) compose it themselves. A
  `subscribe()`-style multi-observer API is a possible future extension.
- **C6 — `mode.run.started`/`run.settled` feasibility. RESOLVED + IMPLEMENTED.**
  Turned out simpler than predicted: the existing `@xstate.snapshot` filter is
  enough. Each `InspectedSnapshotEvent` carries `snap.event` — the event that
  produced the snapshot — so the adapter never needed `@xstate.actor`/
  `@xstate.event`. Derivation (verified by `test/spec013-observability.test.ts`
  against XState 5.31.1):
  - `run.started` ← snapshot whose raw leaf (pre-mask) is `$run`.
  - `run.settled`/`stayed` ← snapshot whose `snap.event.type` is
    `xstate.done.actor.*`; `outcome`/`stay`/`payload` from `event.output` via
    `readDoneOutput`. `durationMs` = `at` − the running mode's recorded start.
  - `trigger` ← `snap.event` when it is not an internal `xstate.*` event.
  - `input` on `run.started` is **deferred to v2** (computed in `buildRunInput`,
    not observable from the snapshot).
- **C7 — `error.recovered` detection. RESOLVED: deferred to v2.** XState
  exposes no direct inspection signal for "a `routes.error` edge recovered," so
  v1 ships the 7 kinds above and leaves recovered errors silent (P2 stays
  partially open). When v2 picks this up, the robust path is a marker threaded
  from the error-edge action (`lowerErrorEdges`, `xstateBackend.ts:298`) rather
  than fragile snapshot inference.
- **C8 — Payload serialization. RESOLVED: by reference.** `payload`/`error`/
  `trigger`/`context` are delivered as live references (zero-copy). Observers
  MUST NOT mutate them; a host that needs to retain/serialize clones on its
  side. Documented in the Behavior Contract.
