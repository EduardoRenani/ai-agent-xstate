# 009 — Snapshot-Aware Rehydration and Atlas Actor Surface

## Status

Done.

## Goal

Pull the actor lifecycle, the observation seam, and snapshot persistence into
Atlas's public surface so that:

1. Hosts that rebuild the machine per turn (the canonical multi-turn agent
   pattern) can rehydrate the full state — including `CompoundMode` `local`
   slots — from a persisted snapshot, instead of always re-running the
   compound's `entry` actions and wiping local state. See issue #15.
2. Hosts no longer import from `xstate` directly: there is an Atlas entry
   point that wraps `createActor`, a typed observation callback that emits
   mode-vocabulary events, and an opaque snapshot type. See issue #12.

After this spec, a host file that boots an Atlas agent imports from
`@eduardorenani/atlasjs` and only from `@eduardorenani/atlasjs`.

## Problems Addressed

### P12 — Compound `local` cannot survive a snapshot/rehydration round-trip in practice

`packages/atlas/src/types.ts:604-611` constrains `CompoundContext.local` to
`JsonCompatible<TLocal>`, and the docstring at `types.ts:588-591` justifies the
constraint by saying _"the slot is persisted as part of the root context."_
That sentence promises the slot survives persistence.

The lowered machine defeats that promise. `packages/atlas/src/contextLift.ts:202-215`
emits an `entry` action that resets the slot to `initialLocal` on entry and an
`exit` action that clears it on exit. Hosts that rebuild the machine every turn
via `createActor(agentMachine).start()` re-enter every active compound, so the
locals declared at any compound on the active mode path are wiped before user
code observes them.

The reset-on-re-entry rule (DD-018) is correct for intra-turn dynamics. It is
wrong for the rehydration path, where the user expects the snapshot they
persisted to be the snapshot they get back. XState v5's `createActor(machine,
{ snapshot })` does NOT re-run `entry` actions on the restored state, so the
fix is to route the persisted snapshot into that call — which today is buried
inside user code that the wrapper does not own.

### P13 — XState leakage on the runtime/observation seam (issue #12)

`examples/zoe/src/machine.ts:1-67` imports `createActor` from `xstate`, filters
on the magic event type `"@xstate.snapshot"`, walks the nested `snapshot.value`
shape manually to format a mode-path string, and compares `actorRef` against
its own outer reference to skip events from foreign actors. None of these
concerns belong in user code: the declarative side of Atlas is XState-free,
but the actor boot and observation seam exposes the full XState API surface
back to the user.

These two problems share a fix: a single Atlas entry point that wraps the
actor lifecycle, accepts a persisted snapshot, and surfaces observation events
in Atlas vocabulary.

## Public API Changes

### `startAgent`

```ts
/**
 * Boot an Atlas agent. Wraps XState's `createActor(...).start()`, threading
 * an optional persisted snapshot into the actor so compound `local` slots
 * and root context survive cross-turn rebuilds.
 *
 * `inspect` receives Atlas-vocabulary events (see `AgentInspectionEvent`).
 * Today's only emitted event kind is `"transition"` — the mode-path before
 * and after, plus the root context.
 *
 * The returned `AgentActor` is auto-started. Call `.stop()` to dispose.
 */
export function startAgent<TContext, TEvents extends { type: string }>(
    agent: AnyStateMachine,
    options?: StartAgentOptions<TContext, TEvents>,
): AgentActor<TContext, TEvents>;

export type StartAgentOptions<TContext, TEvents extends { type: string }> = {
    snapshot?: AgentSnapshot<TContext>;
    inspect?: (event: AgentInspectionEvent<TContext>) => void;
};
```

### `AgentActor`

Opaque actor brand. Surfaces only the methods Atlas hosts genuinely need.
Everything else from XState's `Actor` API is hidden behind the brand so users
do not start depending on it.

```ts
export type AgentActor<TContext, TEvents extends { type: string }> = {
    send: (event: TEvents) => void;
    stop: () => void;
    /** Current snapshot, suitable for persistence. */
    getSnapshot: () => AgentSnapshot<TContext>;
};
```

`getSnapshot` is exposed on the actor (not as a free function) because it
needs the actor as receiver. Hosts call `actor.getSnapshot()` at end of turn
and feed the result back to the next `startAgent({ snapshot })` call.

### `AgentSnapshot`

Opaque snapshot type. Internally wraps XState's `SnapshotFrom<AnyStateMachine>`,
plus a version stamp that lets storage detect cross-version drift.

```ts
declare const __agentSnapshotBrand: unique symbol;

export type AgentSnapshot<TContext> = {
    readonly atlasVersion: string;
    readonly persisted: unknown;  // XState's PersistedSnapshot, hidden
    readonly [__agentSnapshotBrand]: TContext;
};
```

The brand carries `TContext` phantomly so `startAgent<TContext>` can refuse a
snapshot from a different agent shape at the type level. The host treats the
value as opaque: persist `JSON.stringify(snapshot)`, restore with `JSON.parse`
and a runtime type assertion at the boundary.

### `AgentInspectionEvent`

Atlas-vocabulary event union for `inspect`. Phase 1 emits a single kind; the
union shape leaves room for future kinds (`enter`, `exit`, `error`) without
breaking the callback signature.

```ts
export type AgentInspectionEvent<TContext> =
    | {
        type: "transition";
        from: string;       // mode-path before, e.g. "socratic.teaching"
        to: string;         // mode-path after,  e.g. "socratic.evaluating"
        context: TContext;  // root context AFTER the transition
    };
```

`from` / `to` are the Atlas-formatted mode path (dot-joined, parent first),
computed by a wrapper-internal `formatModePath` that walks the nested XState
`snapshot.value` once and returns a stable string. The host no longer touches
XState's nested value shape.

## Persistence Contract

The contract Atlas guarantees, given `snap = actor.getSnapshot()` and a fresh
`actor2 = startAgent(agent, { snapshot: snap })`:

| Atlas concept | Survives `snap` → `actor2` |
| --- | --- |
| Root `AgentConfig.context` (every key) | Yes |
| Active mode path (which leaves/compounds are entered) | Yes |
| `CompoundMode` `local` slots on the active path | **Yes** (this is the change) |
| `CompoundMode` `inherit` keys | Live-mirrored as always; their root keys survive per row 1 |
| Pending events queued mid-turn | No (out of scope — hosts dispatch one event per turn) |
| Active timers (`after`) | No (XState limitation; documented) |
| Invoked child actors | No (Atlas does not currently expose `invoke`) |

The rule for `local`: the slot is **populated from the snapshot on restore**.
The compound's `entry` action does NOT overwrite a slot that the snapshot
already provides. A genuine intra-turn re-entry (parent transitions away,
then back) still resets the slot per DD-018 — that path runs `entry` from
scratch because no snapshot is involved. Spec 005 §`JsonCompatible` keeps its
meaning: the local must be JSON-safe so the snapshot can round-trip storage.

The implementation hook: XState v5's `createActor(machine, { snapshot })` does
not re-execute `entry` actions on the restored state; it materializes the
context from the snapshot directly. So routing the snapshot through that
constructor is sufficient — no special-case work in `contextLift.ts`.

### Recommended host pattern

The canonical multi-turn host is one `runTurn(text, snapshot?)` call per
incoming message. It boots a fresh actor from the previous snapshot, sends
the message, waits via the `inspect` callback until the agent transitions
back to its "ready" mode (the leaf that consumes the next user event), then
captures and returns the new snapshot:

```ts
async function runTurn(
    text: string,
    snapshot?: AgentSnapshot<AgentContext>,
): Promise<AgentSnapshot<AgentContext>> {
    let resolveReady: (() => void) | null = null;
    const actor = startAgent<AgentContext, AgentEvents>(agentMachine, {
        snapshot,
        inspect: (e) => {
            if (e.type === "transition" && e.to === "listening" && resolveReady) {
                const r = resolveReady;
                resolveReady = null;
                r();
            }
        },
    });
    const ready = new Promise<void>((r) => { resolveReady = r; });
    actor.send({ type: "MESSAGE", text });
    await ready;
    const next = actor.getSnapshot();
    actor.stop();
    return next;
}
```

The readiness gate is host-implemented from the `inspect` primitive — no
`subscribe`, no `can`. The host knows which leaf consumes the next event
(here, `"listening"`); Atlas does not need to infer it.

`AgentSnapshot` is JSON-safe by construction — `atlasVersion` is a string,
`persisted` is whatever XState's `getPersistedSnapshot()` returns (XState
guarantees JSON-serializability), and the `TContext` brand is type-only
(no runtime property). The example demonstrates this end-to-end with a
file-backed `sessionStore.ts`:

```ts
// Load from disk → run one turn → save back. The snapshot is the only
// thing that crosses the turn boundary; everything else (the actor, the
// inspect closure, the readiness Promise) lives one turn and dies.
const previous = await loadSession(id);
const next = await runTurn(text, previous);
await saveSession(id, next);
```

`loadSession` is `JSON.parse(readFile(...))` cast to
`AgentSnapshot<TContext>` at the trust boundary; `saveSession` is
`writeFile(JSON.stringify(snapshot))`. The cross-turn proof becomes
literal: kill the process, restart it, the agent resumes mid-conversation
including any compound-`local` state.

## Mapping — Wrapper → XState

| Atlas surface | XState equivalent |
| --- | --- |
| `startAgent(agent, { snapshot, inspect })` | `createActor(agent, { snapshot: snap?.persisted, inspect: wrappedInspect }).start()` |
| `actor.send(ev)` | `xstateActor.send(ev)` |
| `actor.stop()` | `xstateActor.stop()` |
| `actor.getSnapshot()` | `{ atlasVersion: ATLAS_VERSION, persisted: xstateActor.getPersistedSnapshot(), [brand]: undefined }` |
| `inspect: e => ...` (Atlas event) | XState `inspect: raw => { if (raw.type !== "@xstate.snapshot") return; if (raw.actorRef !== xstateActor) return; emit transition }` |
| `formatModePath(value)` | Internal — walks XState's nested `value` shape exactly like `examples/zoe/src/machine.ts:42-50` does today |

`wrappedInspect` is the only non-trivial piece: it tracks the previous mode
path per actor (closure-local, no leaking state), and emits a `transition`
event only when the path actually changes — same shape the zoe example
implements inline today, lifted into the wrapper.

## What does NOT change

- **Declarative authoring surface.** `defineMode`, `defineCompoundMode`,
  `defineAgent` are unchanged.
- **`contextLift.ts` semantics.** Compound `local` entry/exit actions stay
  exactly as they are. The behavior change is upstream — what `createActor`
  does with the snapshot, not what `entry` does in the absence of one.
- **DD-018.** Reset-on-re-entry remains the rule for intra-turn dynamics.
  The clarification this spec ships is _"reset on re-entry; NOT reset on
  snapshot restore."_
- **Event union typing.** `actor.send(event)` accepts the same event union
  the user declared on `AgentConfig.events`.
- **`createActor` is still the boundary.** Atlas continues to lower to a
  standard XState machine and use XState's actor; the wrapper hides it, not
  replaces it.

## File Map

| File | Change |
| --- | --- |
| `docs/specs/009-snapshot-aware-rehydration.md` | New spec (this document) |
| `docs/specs/README.md` | Add row 009, status Draft |
| `docs/design-decisions.md` | New DD: rehydration semantics for compound `local` (snapshot wins over entry-reset); Atlas actor surface as the runtime boundary |
| `docs/specs/004-xstate-agent-wrapper.md` | Forward-pointer at §Verification (the "no `xstate` import" rule) → spec 009 closes it |
| `docs/specs/005-agent-deps-and-stringifiable-context.md` | Forward-pointer at §`JsonCompatible` referencing the rehydration contract here |
| `packages/atlas/src/startAgent.ts` | New entry point: actor wrapper, inspect wrapper, `getSnapshot` |
| `packages/atlas/src/formatModePath.ts` | New: mode-path formatter lifted from `examples/zoe/src/machine.ts:42-50` |
| `packages/atlas/src/types.ts` | Public types: `AgentActor`, `AgentSnapshot`, `AgentInspectionEvent`, `StartAgentOptions`. Update DD-018 docstring on `CompoundContext.local`: _"reset on re-entry, **not** on snapshot restore."_ Remove _"the slot is persisted as part of the root context"_ from the `local` docstring (it overpromises; the actual reason is JSON-safety for snapshot serialization). |
| `packages/atlas/src/defineCompoundMode.ts:58` | Same docstring fix on the alias-level prose |
| `packages/atlas/src/index.ts` | Re-export `startAgent`; re-export the new types |
| `packages/atlas/test/startAgent.test.ts` | New: see Verification |
| `examples/zoe/src/machine.ts` | Drop the `xstate` import. Export only `agentMachine` — actor boot moves out of this file. |
| `examples/zoe/src/turn.ts` | New. `runTurn(text, snapshot?)` is the API-shaped primitive: boots a fresh actor from the previous snapshot, sends `MESSAGE`, waits for the inspect-driven `transition → listening` signal, returns the next snapshot. Demonstrates the rehydration contract end-to-end. |
| `examples/zoe/src/sessionStore.ts` | New. File-backed `loadSession(id)` / `saveSession(id, snapshot)` — the persistence boundary the spec contract crosses. Mirrors a production HTTP / queue host storing snapshots in a DB: the only thing that survives between turns is the JSON payload on disk. Without this round-trip, the example would prove nothing about issue #15. |
| `examples/zoe/src/index.ts` | Thin terminal loop that delegates each line to `runTurn`, with `loadSession` before and `saveSession` after. No `actor.start()`, no `actor.subscribe()`, no `getSnapshot().can()` — those XState surfaces are no longer needed once the turn loop is API-shaped. |
| `.gitignore` | Ignore `.zoe-sessions/` — the per-session snapshot files written by `saveSession`. |

## Migration

Single PR. The wrapper changes are additive; the existing `defineAgent` /
`createActor` path still compiles (we just stop using it from zoe).

1. **`types.ts`** — add `AgentActor`, `AgentSnapshot`, `AgentInspectionEvent`,
   `StartAgentOptions`. Fix the `local` docstring (DD-018 phrasing).
2. **`formatModePath.ts`** — extracted from zoe's `formatStateValue`. Pure
   function over XState's `Value` union.
3. **`startAgent.ts`** — calls `createActor(agent, { snapshot, inspect })`,
   wraps the actor into `AgentActor`, wires the inspect adapter that emits
   Atlas events.
4. **`index.ts`** — re-export `startAgent` and the new types.
5. **`defineCompoundMode.ts`** — docstring fix only.
6. **`startAgent.test.ts`** — new tests.
7. **`examples/zoe/src/machine.ts`** — replace `createAgentActor` with a
   `startAgent` call. Remove the `xstate` import and `formatStateValue`. The
   `[transition] X → Y` console log moves into the `inspect` callback that
   `startAgent` accepts.
8. **`examples/zoe/src/index.ts`** — if there is a session-persistence layer
   today, switch it to the new snapshot shape.

## Verification

1. **Snapshot survives compound `local` round-trip** (the issue #15 fix):
   - Define an agent with a `CompoundMode` declaring `local: { intakeData:
     Partial<...> }`.
   - Boot via `startAgent`, send an event that causes a child to write
     `intakeData.name = "Ana"`.
   - Capture `snap = actor.getSnapshot()`, stop the actor.
   - Boot a second actor via `startAgent(agent, { snapshot: snap })`.
   - Assert: the second actor's current state reads `intakeData.name === "Ana"`.
2. **Intra-turn re-entry still resets `local`** (DD-018 preserved):
   - Same agent, no snapshot path. Drive the compound to enter → exit → enter
     again within one actor lifetime.
   - Assert: on the second entry, `intakeData` equals the declared `initialLocal`.
3. **`inspect` emits `transition` only on path change**:
   - Drive a sequence of events; assert one `transition` event per genuine
     mode-path change, and zero for self-events that don't change the path.
4. **`from`/`to` carry full dot-joined mode paths**:
   - Including nested compounds: `socratic.teaching → socratic.evaluating`.
5. **Type-only tests** (`test/types/*.test-d.ts`):
   - `AgentSnapshot<CtxA>` is not assignable to `AgentSnapshot<CtxB>` when
     `CtxA ≠ CtxB`.
   - `startAgent` infers `TContext`/`TEvents` from the machine and rejects
     `send(ev)` calls outside the declared event union.
   - `actor.getSnapshot()` returns `AgentSnapshot<TContext>` typed against the
     same `TContext`.
6. **No xstate leakage in `examples/zoe/src/`**:
   - `grep -r 'from "xstate"' examples/zoe/src/` returns no matches.
   - `grep -r '@xstate\.' examples/zoe/src/` returns no matches.
   - Spec 004 §Verification's wrapper-invariant grep checks pass (closes
     issue #12).
7. **Zoe smoke**: all eight conversation scenarios in spec 003 §Verification
   still pass against the migrated machine, including any that depend on
   multi-turn state via compound `local`.

## Out of Scope

- **Restoring active timers (`after`) or invoked child actors.** XState's
  documented limitation; Atlas does not currently expose either to user code.
- **Cross-version snapshot migration.** `AgentSnapshot.atlasVersion` lets a
  host *detect* version drift, but Atlas does not ship migration helpers.
- **Schema validation on restore.** If the user mutates the machine shape
  (renames a mode, drops a compound) and feeds an old snapshot, behavior is
  XState's behavior — typically a clean reset to `initial`. A schema fingerprint
  could be added later; not in this spec.
- **Subscribe / multi-listener observation.** `inspect` is construction-time
  only. If a host needs runtime add/remove of listeners, that's a follow-up
  spec.
- **Streaming snapshots between turns** (server-pushed actor state). Out of
  scope.
- **A free-function `getSnapshot(actor)`.** Folded into `actor.getSnapshot()`
  to keep the actor as the natural receiver.

## Clarifications

Settled:

1. **Inspection event coverage in Phase 1.** Resolved: `transition` only.
   `enter` / `exit` are deferred until a host actually needs them.
2. **Subscribe surface.** Resolved: construction-time `inspect` only. Symmetry
   with deps-freezing at boot.
3. **Snapshot version field.** Resolved: coarse tag (e.g. `"1"`), bumped only
   when the snapshot shape itself changes. Decouples from package version churn.
4. **Snapshot/machine-shape mismatch handling.** Resolved (Phase 1): pass
   through XState's soft-reset behavior, document the risk. A schema
   fingerprint can be added later without breaking the snapshot shape — the
   reserved `atlasVersion` field gives us room to evolve.
5. **`AgentActor.start()` vs auto-start.** Resolved: auto-start. `inspect`
   fires on the post-start snapshot, so it still observes the very first
   transition from `initial`.
6. **`formatModePath` separator.** Resolved: `.` only; throw on parallel
   regions (defensive — Atlas does not lower to parallel).
