# 010 — Host-Side Error Channel (`onError`)

## Status

Completed.

## Goal

Add a construction-time error callback to `startAgent` so hosts can observe
every rejection that escapes the agent's state machine, without:

1. Losing the rejection to `unhandledRejection` at the Node process level.
2. Being forced to handle the error inside `routes.error.assign` (which only
   has access to `deps` — not to host-level context like request id, trace
   id, Sentry session, or HTTP response).

After this spec, a host that calls `startAgent(machine, { onError })` has an
in-band hook for every rejection that escapes the machine, with the same
mode-path vocabulary the `inspect` callback already speaks.

## Problems Addressed

### P14 — `behavior` rejections that escape the machine have no host-side hook

Spec 009 §Clarifications #1 explicitly deferred `enter` / `exit` / `error`
event kinds in `AgentInspectionEvent`: _"deferred until a host actually
needs them."_ This spec is that "actually needs them" landing.

The concrete failure mode in alpha.3:

- A leaf's `behavior` rejects (LLM transport error, downstream 5xx, HTTP
  timeout).
- The leaf omits `routes.error` (or matches a `target: RE_THROW` entry),
  so XState escalates the rejection above the leaf.
- `packages/atlas/src/startAgent.ts:54` filters the inspect stream to
  `raw.type === "@xstate.snapshot"` only — `@xstate.error` and the actor's
  `subscribe.error` observer are not exposed at all.
- The rejection becomes an uncaught process-level error. Worse, the host's
  readiness-gate pattern (Promise resolved on `inspect → transition →
  listening`) never settles, because no transition fires — the actor enters
  XState's error state and stops. `runTurn` hangs until the host's outer
  timeout (typically 30s) fires.

The fix is to expose XState v5's actor-level error observer
(`actor.subscribe({ error })`) at the Atlas surface, in the same
construction-time shape spec 009 established for `inspect`.

This is the inverse of P13: P13 closed the *positive* observation seam
(transitions); P14 closes the *negative* one (escapes).

## Public API Changes

### `StartAgentOptions` — new optional `onError`

```ts
export type StartAgentOptions<TContext> = {
    snapshot?: AgentSnapshot<TContext>;
    inspect?: (event: AgentInspectionEvent<TContext>) => void;
    onError?: (info: AgentErrorInfo<TContext>) => void;
};
```

### `AgentErrorInfo`

```ts
export type AgentErrorInfo<TContext> = {
    /**
     * The rejection value. Typed as `unknown` because `behavior` is a user
     * promise and may reject with anything. Host narrows in the callback
     * (typically via `error instanceof Error` or a custom error type guard).
     */
    error: unknown;

    /**
     * Dot-joined mode-path of the leaf whose `behavior` rejected, computed
     * by the same `formatModePath` that `inspect.transition.from`/`to` use.
     * For a leaf at `socratic.teaching`, this is `"socratic.teaching"`.
     */
    modePath: string;

    /**
     * Root context at the moment the rejection escaped — equivalent to
     * `actor.getSnapshot().context` read synchronously inside the error
     * subscriber. On the escape paths (no `routes.error`, no entry
     * matched, or matched `target: RE_THROW`), no `routes.error.assign`
     * runs — Atlas's compile step drops `assign` on `RE_THROW` entries
     * (spec 004 §`RE_THROW`, `buildActiveState.ts:277-279`), and the
     * other two paths have no entry to assign with. The recovery path
     * (`target: <sibling>` with optional `assign`) is intra-machine and
     * does NOT fire `onError`, so its assigns are observed via `inspect`,
     * not here. `info.context` therefore reflects whatever the root
     * context held entering the failed leaf, plus any assigns from
     * earlier transitions in the run.
     */
    context: TContext;

    /**
     * The agent snapshot at the moment of error, suitable for persistence.
     * Captured by the wrapper before the actor enters its terminal error
     * state. Hosts that want to "fire-and-log and keep listening" persist
     * this snapshot and feed it to the next `startAgent({ snapshot })` call
     * — the rebuild-fresh-from-snapshot pattern spec 009 already documents.
     */
    snapshot: AgentSnapshot<TContext>;
};
```

`AgentErrorInfo` is exported from `@eduardorenani/atlasjs`. The phantom
`TContext` is shared with `AgentSnapshot<TContext>` so the typed pair
`onError(info) → startAgent({ snapshot: info.snapshot })` is type-safe at
the boundary.

### `AgentActor` — unchanged

No new methods on the actor surface. `onError` is construction-time only,
matching the `inspect` symmetry established by spec 009 §Clarification 2.

## Behavior Contract

The contract Atlas guarantees, given `onError` is provided:

| Scenario                                                                 | `onError` fires? | Actor lifecycle after error                                    |
| ------------------------------------------------------------------------ | ---------------- | -------------------------------------------------------------- |
| Leaf rejects, no `routes.error` declared                                 | Yes              | Actor enters `error` status (XState default; `send` is a no-op) |
| Leaf rejects, `routes.error` declared with matched `target: <sibling>`   | **No**           | Machine transitions to `<sibling>`; actor lives                |
| Leaf rejects, `routes.error` declared with matched `target: RE_THROW`    | Yes              | Actor enters `error` status                                    |
| Leaf rejects, `routes.error` declared but no entry's `when` matches      | Yes              | Actor enters `error` status (same as no-routes case)           |
| Leaf rejects above a compound whose `routes.error` is absent             | Yes              | Bubbles per DD-017 / `compile.ts:570-575`, then escapes        |

**Rule:** `onError` is the **escape channel**. It fires precisely when the
rejection escapes the machine's declarative recovery — i.e., when XState's
own `actor.subscribe({ error })` fires. Intra-machine recovery via
`routes.error: { target: <sibling> }` is unchanged and consumes the
rejection silently, exactly as today.

This is not a design choice — it's a direct consequence of how XState v5
propagates invoke errors. The wrapper does not invent a parallel "fire on
every rejection" channel; doing so would require intercepting at the actor
logic level and double-firing for rejections the machine already caught,
which contradicts the four-outcome contract (`routes.error` IS the
machine-level recovery slot per DD-013).

### When `onError` is omitted

**Current behavior is preserved.** The wrapper does not subscribe to the
actor's error channel when `onError` is undefined. Rejections continue to
follow XState's default propagation — typically surfacing as an uncaught
exception at the Node process level. This makes spec 010 strictly additive:
no behavior change for hosts that don't opt in.

### `inspect` ordering

If both `inspect` and `onError` are provided, no transition event fires for
an escape (because no transition occurs in the machine — the actor goes
straight to `error` status). The host's readiness gate built on `inspect`
must therefore also settle on `onError`. The recommended pattern below
covers this explicitly.

### Snapshot-at-error semantics

`AgentErrorInfo.snapshot` is captured by calling
`xstateActor.getPersistedSnapshot()` from inside the `subscribe.error`
callback, before the actor's terminal state is observable to `send`. The
captured snapshot reflects the machine state **including** the failed
leaf's mode-path as active — feeding it to a fresh `startAgent({ snapshot })`
re-enters that leaf. This is intentional: the host decides what to do (boot
fresh from the leaf, route around it by sending an event, fall back to a
snapshot from a prior turn, etc.). The wrapper does not editorialize.

## Recommended host pattern — fire-and-log

The canonical "log the error externally, keep the agent listening" pattern:

```ts
async function runTurn(
    text: string,
    snapshot?: AgentSnapshot<Ctx>,
    requestCtx: { traceId: string; userId: string },
): Promise<AgentSnapshot<Ctx>> {
    let resolveReady: (() => void) | null = null;
    let errorSnapshot: AgentSnapshot<Ctx> | null = null;

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
            // Host-level log with full request context. The machine never
            // sees `requestCtx` — that's the whole point of the channel.
            logger.error({
                err: info.error,
                modePath: info.modePath,
                traceId: requestCtx.traceId,
                userId: requestCtx.userId,
            }, "agent escape");
            errorSnapshot = info.snapshot;
            if (resolveReady) {
                const r = resolveReady;
                resolveReady = null;
                r();
            }
        },
    });

    const ready = new Promise<void>((r) => { resolveReady = r; });
    actor.send({ type: "MESSAGE", text });
    await ready;

    // If we errored, persist the prior turn's snapshot (or the error
    // snapshot if the host wants to re-enter the failed leaf). For a
    // fire-and-log AC, persist the prior snapshot so the next turn
    // restarts at `listening`.
    const next = errorSnapshot !== null
        ? (snapshot ?? actor.getSnapshot())
        : actor.getSnapshot();
    actor.stop();
    return next;
}
```

The readiness gate now settles on either `inspect.transition → listening`
**or** `onError`. The dispatcher decides whether the error snapshot or the
prior snapshot crosses the turn boundary — both are typed
`AgentSnapshot<Ctx>` and feed `startAgent` the same way.

This pattern resolves AC#5 (fire-and-log) end-to-end:

- LLM/transport rejection → `onError` fires with host's request context.
- `runTurn` settles instead of timing out.
- Next turn boots from the prior snapshot; agent is back at `listening`.
- Logging happens in the dispatcher with the full request frame.

## Mapping — Wrapper → XState

| Atlas surface                          | XState equivalent                                                                                                |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `startAgent(m, { onError })`           | `createActor(m, { snapshot, inspect: ... }).start()` + `actor.subscribe({ error: wrappedError })` (when present) |
| `wrappedError(err)`                    | Reads `xstateActor.getSnapshot()` for value/context; calls `xstateActor.getPersistedSnapshot()`; emits `AgentErrorInfo` via `onError` |

`wrappedError` is the only new internal hook. It captures the snapshot
synchronously inside the error callback (XState's subscribe.error is sync),
formats the mode-path via the existing `formatModePath`, and invokes the
host's `onError` exactly once per escape.

The subscription is set up only when `onError !== undefined`. When omitted,
`startAgent` makes no `subscribe` call — XState's default propagation
applies (backwards-compat invariant).

## What does NOT change

- **`AgentInspectionEvent`** — stays a single-variant union `{ type:
  "transition"; ... }`. Adding an `error` variant to that union was rejected
  in favor of a separate `onError` callback. See §Clarifications #1.
- **`routes.error`** — declarative semantics unchanged. Intra-machine
  recovery via `target: <sibling>` still consumes the rejection silently.
  `RE_THROW` still re-throws. `assign` on matched entries still runs.
- **`AgentActor`** — `send` / `stop` / `getSnapshot` only. No `recover`,
  no `restart`, no `clearError`. Recovery is a host concern via the
  multi-turn rebuild pattern.
- **DD-013** — the four-outcome `Routes` contract holds. `error` is still
  the machine-level slot; `onError` is the host-level escape channel. The
  two compose, they don't overlap.
- **Default behavior with no `onError`** — preserved. Spec 010 is
  strictly additive.

## File Map

| File                                                       | Change                                                                                                  |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `docs/specs/010-error-channel.md`                          | New spec (this document).                                                                               |
| `docs/specs/README.md`                                     | Add row 010, status Draft.                                                                              |
| `docs/design-decisions.md`                                 | New DD-028: "`onError` is the host-side escape channel; XState `subscribe.error` is its implementation hook." Records the always-fire-on-escape semantics and the additive-default rule. |
| `packages/atlas/src/startAgent.ts`                         | Plumb `onError` into a conditional `xstateActor.subscribe({ error })`; capture snapshot + mode-path at error time.   |
| `packages/atlas/src/types.ts`                              | New `AgentErrorInfo<TContext>`; extend `StartAgentOptions<TContext>` with `onError?`. JSDoc both.       |
| `packages/atlas/src/index.ts`                              | Re-export `AgentErrorInfo`.                                                                             |
| `packages/atlas/test/startAgent.test.ts`                   | New: see Verification.                                                                                  |
| `docs/USAGE.md`                                            | §6 (Multi-turn agents) gains a subsection on the `onError` channel + the fire-and-log pattern.          |
| `packages/atlas/README.md`                                 | "Multi-turn agents" section updated with the `onError` callback and a one-line fire-and-log note.       |
| `docs/specs/009-snapshot-aware-rehydration.md`             | Cross-reference at §Clarifications #1: _"error variant landed in spec 010 as a separate `onError` callback."_ |

## Migration

Single PR. Strictly additive — no host that ships against alpha.3 needs to
change a line.

1. **`types.ts`** — `AgentErrorInfo<TContext>` + `StartAgentOptions.onError?`.
2. **`startAgent.ts`** — conditional subscribe; mode-path + snapshot
   capture inside the error handler.
3. **`index.ts`** — re-export `AgentErrorInfo`.
4. **`startAgent.test.ts`** — new tests.
5. **`docs/USAGE.md` + `packages/atlas/README.md`** — document the channel
   and the recommended fire-and-log pattern.
6. **`docs/specs/009-...md`** — short forward-pointer at Clarification #1
   noting 010 closed the deferred error kind.
7. **`docs/specs/README.md`** + **`docs/design-decisions.md`** — index +
   DD-028.
8. **Release notes** for `@eduardorenani/atlasjs@0.1.0-alpha.4`: "Added
   `startAgent({ onError })` for host-side rejection handling. Strictly
   additive — no migration required."

## Verification

1. **Rejection without `routes.error` fires `onError`**:
   - Leaf with `behavior: async () => { throw new Error("boom"); }` and no
     `routes.error`.
   - Boot via `startAgent(m, { onError })`, send the event that enters the
     leaf.
   - Assert: `onError` fires exactly once. `info.error` is the thrown
     `Error`. `info.modePath` equals the leaf's dot-joined path.
     `info.snapshot.atlasVersion === "1"`.
2. **Rejection with `routes.error: { target: <sibling> }` does NOT fire `onError`**:
   - Same leaf, but declare `routes.error: { target: "listening", assign:
     () => ({}) }`.
   - Boot with both `inspect` and `onError`. Drive the rejection.
   - Assert: `inspect` fires `transition: <leaf> → listening`. `onError`
     does **not** fire.
3. **Rejection routing to `RE_THROW` fires `onError`**:
   - `routes.error: { when: () => true, target: RE_THROW }`.
   - Assert: `onError` fires; `inspect` does not emit a recovery transition
     for that path.
4. **`onError` omitted preserves XState default**:
   - The "no `subscribe` call when `onError` is undefined" contract is
     structurally enforced by `startAgent.ts`'s
     `if (userOnError !== undefined)` guard — a runtime assertion
     would have to spy on the XState actor's internal subscriber count,
     which the wrapper deliberately hides. The runtime test covers the
     observable surface: `startAgent(m)` (no `onError`) returns a
     working actor and the inspect path is unchanged from spec 009.
   - Asserting on the resulting `unhandledRejection` is intentionally
     not done in tests — vitest installs its own process-level handler
     and Node delivers to all listeners, so a test-scoped handler can't
     prevent the suite from being flagged.
5. **`info.snapshot` rehydrates the failed leaf**:
   - Capture `info.snapshot`, feed it to a fresh `startAgent({ snapshot })`.
   - Assert: the second actor's initial mode-path equals the failed leaf's
     path. (Demonstrates the snapshot is taken pre-terminal.)
6. **`info.context` reflects pre-failure root context**:
   - Active leaf with an `assign` on `routes.achieved` that sets
     `context.runId = "r1"`. A subsequent leaf with rejecting `behavior`
     and no `routes.error`.
   - Drive: first leaf achieves (assigns runId), second leaf rejects.
   - Assert: `info.context.runId === "r1"`. The escape-path assigns
     (none in this scenario, see `AgentErrorInfo.context` JSDoc) do not
     run; the host observes whatever the root context held entering
     the failed leaf. This also pins down that snapshot capture happens
     synchronously inside `subscribe.error` — context is not lost when
     the actor enters error status.
7. **Readiness gate pattern settles on both channels** (integration):
   - Build the `runTurn` example from §Recommended host pattern.
   - First call: success path. `inspect → listening` settles the gate.
   - Second call: failure path. `onError` settles the gate. Assert
     `runTurn` resolves in both cases under a 1s timeout (no 30s hang).
8. **Type-only tests** (`test/types/*.test-d.ts`):
   - `AgentErrorInfo<CtxA>` is not assignable to `AgentErrorInfo<CtxB>`
     when `CtxA ≠ CtxB`.
   - `onError` is typed as `(info: AgentErrorInfo<TContext>) => void`.
     Returning a value (non-void) compiles per `void` lenience, but
     `info.error` is `unknown` (no implicit widening to `Error`).
   - `info.snapshot` is typed `AgentSnapshot<TContext>` and feeds
     `startAgent<TContext, TEvents>({ snapshot: info.snapshot })` without
     a cast.

## Out of Scope

- **Always-fire-on-rejection semantics** (firing `onError` even when
  `routes.error` catches). Requires intercepting at the actor logic level
  and double-firing for handled errors — contradicts DD-013's four-outcome
  contract. If a future host genuinely needs both intra-machine recovery
  AND external observation of caught errors, the cleanest model is to log
  inside `routes.error.assign` via `deps.logger` (the channel that already
  exists). Spec 010 closes only the escape gap.
- **Runtime add/remove of error handlers.** Construction-time only, same
  invariant as `inspect` (spec 009 §Clarification 2).
- **Multi-listener `onError`.** Same reason. Hosts compose their own fan-out
  inside the single callback if they need it.
- **`actor.recover()` or in-actor restart from error state.** Recovery is a
  host concern via the multi-turn rebuild pattern (spec 009). Adding an
  in-place recover would compete with that contract.
- **Error filtering by type / `instanceof`.** Host filters in the callback.
  Pushing this into the wrapper would force a runtime predicate registry.
- **Async `onError`.** XState's `subscribe.error` is sync; the host can
  fire-and-forget an async log from the callback, but the wrapper does not
  `await` anything inside the error path (matching `inspect`'s shape).
- **`@xstate.actor` / `@xstate.snapshot` events beyond what spec 009
  already exposes.** Not part of this spec.

## Clarifications

All resolved 2026-06-02 (auto-mode resolution against the recommendations
below). Recorded as the audit trail for the design choice; any future
challenge has to argue against the recommendation, not propose it fresh.

1. **Single callback vs. two callbacks.** Resolved: separate `onError`
   (Shape B). Rejected alternative: extend `AgentInspectionEvent` to a
   discriminated union with an `error` variant (Shape A). Reason: `inspect`
   is observation of *transitions*; `onError` is a *result* channel that
   gates host-level control flow (readiness, retry, request finalization).
   Mixing both into one callback forces every inspect handler to
   `switch (e.type)` even when it only cares about one. The two callbacks
   compose without conflict and the wrapper handles their wiring
   independently.

2. **Snapshot capture timing.** Resolved: call
   `xstateActor.getPersistedSnapshot()` synchronously inside the
   `subscribe.error` handler. Verified against `xstate@5.31.1` (per
   `node_modules/xstate/package.json`): the actor's persisted snapshot is
   readable inside the error subscriber and the failed leaf is still
   present in `value` at that point. Documented as a hard contract in
   §Behavior Contract / §Snapshot-at-error semantics.

3. **`info.error`'s static type.** Resolved: `unknown`. Reason: `behavior`
   is a user-controlled `async` function whose rejection value can be
   anything. Narrowing belongs to the host. Alternative: typed as
   `Error & { cause?: unknown }`. Rejected because TypeScript's `Promise`
   rejection type is `any`, so committing to `Error` would force a runtime
   coercion the wrapper does not perform.

4. **`info.modePath` and parallel regions.** Not applicable — Atlas does
   not lower to parallel regions, and `formatModePath` throws on them
   (spec 009 §Clarification 6). `onError` uses the same formatter, so the
   same invariant holds. Settled by spec 009.

5. **Backwards-compat invariant.** Resolved: when `onError` is omitted, no
   `subscribe` call is made and current Node `unhandledRejection`
   propagation is preserved. Documented as a hard guarantee in
   §Behavior Contract — hosts that ship against alpha.3 see zero change.

6. **Release label.** Resolved: `@eduardorenani/atlasjs@0.1.0-alpha.4`,
   "Added `startAgent({ onError })`." Strictly additive — no breaking-
   change tag, no migration required.

7. **`AgentErrorInfo` version stamp.** Resolved: no `atlasVersion` field
   on `AgentErrorInfo`. It is a transient value, not a persisted one;
   `info.snapshot` already carries the existing snapshot version stamp.

8. **Naming.** Resolved: `onError`. Alternatives considered: `onEscape`
   (more accurate to the semantics but jargon-heavy), `onRejection`
   (Node-flavored), `inspectError` (parallel to `inspect`). `onError`
   wins on convention and reads naturally ("an error escaped") without
   a glossary lookup.
