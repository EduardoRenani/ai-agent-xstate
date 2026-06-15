# 012 — XState Containment: Owned Public Seam, Owned Snapshot Payload, Owned IR

## Status

Draft. Nothing implemented yet. Produced from the 2026-06-11 audit of the
XState coupling surface; every file:line cited below was verified against the
working tree at that date (post spec 011, `@eduardorenani/atlasjs@0.1.0-alpha.6`).

> This spec does **not** replace XState. The recorded decision that XState's
> runtime stays (design-decisions.md:269-272, the rejected-alternatives block
> that textually belongs to DD-012) stands. What this spec does is make the
> project rule — "implement code so that ripping XState out later is an easy
> refactor" (CLAUDE.md) — true again, and transfer ownership of every
> consumer-facing contract from XState to Atlas. After it, a future engine
> swap touches one backend module, one runtime file, and zero consumers.

## Goal

Contain XState behind three Atlas-owned seams so that no consumer-facing
contract — type, install, or persisted data — depends on it:

1. **Owned public seam** — an opaque `Agent<TContext, TEvents>` handle replaces
   `AnyStateMachine` in the two public signatures.
2. **Owned snapshot payload** — `AgentSnapshot.persisted` becomes an
   Atlas-defined shape (`atlasVersion: "2"`), not XState's
   `getPersistedSnapshot()` blob.
3. **Owned IR** — the lowering pipeline produces an Atlas-vocabulary IR; a
   single backend module translates IR → XState machine config and becomes the
   only place below `startAgent` that knows XState exists.

Plus two hardening moves that protect the seams: xstate moves from
peerDependency to a regular dependency, and the load-bearing XState behaviors
get pinned by contract tests in CI.

## Proposed behavior change (bullets)

- `defineAgent` returns `Agent<TContext, TEvents>` (opaque brand) instead of
  XState's `AnyStateMachine`; feeding the result to raw `createActor` no longer
  typechecks.
- `startAgent(agent)` infers `TContext`/`TEvents` from the `Agent` brand; the
  explicit `startAgent<Ctx, Ev>(...)` call form keeps compiling only when the
  generics match the brand (mismatch becomes a compile error instead of
  silently wrong types).
- Consumers no longer install xstate: it leaves `peerDependencies`, enters
  `dependencies`, and disappears from the install instructions.
- `AgentSnapshot.persisted` payload changes shape: Atlas-owned
  `{ value, context }` derived from the carrier, stamped `atlasVersion: "2"`.
  Snapshots persisted by alpha hosts under version `"1"` are rejected with the
  existing mismatch behavior (soft reset) — see Clarification C2.
- No other observable behavior changes: lowering semantics, inspection events,
  `onError`, parking/rehydration all stay bit-identical (enforced by the
  existing 240-test suite plus new contract tests).

## Motivation / Problems Addressed

### P18 — XState's `AnyStateMachine` is the public seam, with hollow type safety

`defineAgent` returns `AnyStateMachine` verbatim (`defineAgent.ts:17,81`) and
`startAgent` accepts it (`startAgent.ts:50`); both land in the published
`.d.ts`. Because `AnyStateMachine` erases all generics, `startAgent(machine)`
with no type arguments compiles and accepts `send({type: "anything-goes"})`;
hosts must restate `startAgent<Ctx, Ev>(machine)` at every call
(`packages/atlas/README.md:89`, `examples/zoe/src/turn.ts:56`) and **nothing
checks those generics against the machine** — `startAgent<WrongCtx,
WrongEv>(agentMachine)` compiles. The `AgentSnapshot` brand that "refuses
cross-context restores at the type level" (`types.ts:766-769`) only checks
against the caller-chosen generics, so the promised safety is hollow. On top
of that, `defineAgent`'s own JSDoc teaches the boundary violation: "ready to
pass to `createActor`" (`defineAgent.ts:53,71-73`) — contradicting
`startAgent.ts:11-19` and DD-027.

### P19 — The peer dependency leaks the scaffolding into every consumer's install contract

`"peerDependencies": { "xstate": "^5" }` (`packages/atlas/package.json:28-30`)
forces every host to know about and install XState (`examples/zoe/package.json:12`
declares it with zero xstate imports in code). Peer deps exist for
shared-instance/plugin scenarios; Atlas never accepts or returns user-supplied
XState objects. Replacing the carrier later would break every consumer's
`package.json` — the opposite of "easy refactor".

### P20 — Load-bearing runtime behaviors are pinned to an observation of `xstate@5.31.1` under a floating `^5` range

Three behaviors carry shipped contracts but are owned by nobody:

| Behavior | Where relied on | Contract it carries |
| --- | --- | --- |
| Restore does **not** re-run `entry` actions | `startAgent.ts:35-38` | Whole spec-009 persistence model (compound locals survive) |
| At error time, `getSnapshot()` still has `value`/`context` populated | `startAgent.ts:113-117` (comment pins "xstate@5.31.1") | Spec-010 `AgentErrorInfo.modePath/context/snapshot` |
| `snapshot.getMeta()` exposes active-node meta | `startAgent.ts:151-160` | The `awaiting` readiness signal (spec 011) |

Spec 010 itself admits the escape timing "is not a design choice — it's a
direct consequence of how XState v5 propagates invoke errors"
(`docs/specs/010-error-channel.md:136-141`). Upstream ships roughly monthly
minors; any 5.x can drift these without violating semver, and no test would
notice.

### P21 — Persisted snapshots are XState's format verbatim: on-disk data owned by a third party

`AgentSnapshot.persisted` is typed `unknown` (good opacity, `types.ts:774-778`)
but its **value** is `getPersistedSnapshot()` output verbatim
(`startAgent.ts:126,142,162-167`). Hosts JSON-persist it to durable storage
(zoe's session store, per spec 009), so XState's undocumented snapshot schema
is a de-facto external contract. This is the single worst lock-in and its exit
cost is a steeply increasing function of time: at alpha it costs a version
bump; post-GA it costs migration tooling. `atlasVersion: "1"`
(`startAgent.ts:30`) exists precisely as the escape hatch — this spec uses it.

### P22 — The lowered IR is hand-typed XState config: ~1,885 of 3,991 src lines are shaped by the carrier

There is no Atlas-owned intermediate representation. The `Lowered*` types
mirror XState v5 config structurally — `invoke/src/onDone/onError`
(`buildActiveState.ts:142-149`), `reenter: true` (`:151-155`), `type: "final"`
+ `output` (`injectEnd.ts:70-73`), `initial/states/entry/exit`
(`compile.ts:89-99`) — and `ReturnType<typeof assign>` is baked into 20+ type
positions crossing module boundaries (`buildActiveState.ts:112,132,153,183`;
`contextLift.ts:165-241`; `compile.ts:97-98`). XState runtime values are
imported in 5 modules below the boundary (`compile.ts:38`,
`buildActiveState.ts:35`, `contextLift.ts:28`, `buildActors.ts:13`,
`buildActions.ts:14`). Consequence: a carrier swap today rewrites `compile.ts`
(718 ln), `buildActiveState.ts` (606), `injectEnd.ts` (317), `contextLift.ts`
(244) — the CLAUDE.md rule is true at the API surface and false for the entire
lowering layer.

## The model

### Seam 1 — `Agent<TContext, TEvents>`: the opaque compiled-agent handle

Same phantom-brand technique already used by `Mode`, `CompoundMode`, and
`AgentSnapshot` (`types.ts:507-520, 763-778`):

```ts
declare const agentBrand: unique symbol;

export type Agent<TContext, TEvents extends EventObject> = {
    readonly [agentBrand]: true;
    // Invariant phantom (function position in AND out), mirroring the
    // __phantomDeps technique — not a covariant property slot.
    readonly __phantomAgent?: (io: { context: TContext; events: TEvents })
        => { context: TContext; events: TEvents };
    /** The compiled carrier machine. Opaque: typed unknown on purpose. */
    readonly carrier: unknown;
};
```

- `defineAgent(config): Agent<TContext, TEvents>` — wraps the compiled machine.
- `startAgent(agent: Agent<TContext, TEvents>, options?)` — **infers** both
  generics from the brand; unwraps `carrier` with a single localized cast
  before `createActor`. The explicit-generics call form remains valid but is
  now cross-checked against the brand.
- `AgentSnapshot<TContext>` restore gains real teeth: snapshot/agent context
  mismatch is now a compile error anchored to the machine, not to whatever the
  caller typed.
- `defineAgent`'s JSDoc/example is rewritten to boot exclusively via
  `startAgent`; all `createActor`/`AnyStateMachine` mentions leave
  consumer-reachable doc text (`defineAgent.ts:6-9,25-26,53,71-73`),
  `AgentConfig.id` is re-worded from "XState machine id" (`types.ts:691`), and
  the `index.ts:1`/`types.ts:1` headers drop the "XState wrapper" framing.

### Seam 2 — Atlas-owned persisted payload (`atlasVersion: "2"`)

Spec 009's survival contract is exactly: **active mode path + root context**
(compound locals and the `$event` slot already live in context as
`__<path>_local` / `$event`). So the persisted payload Atlas actually needs is:

```ts
type PersistedAgentSnapshotV2 = {
    readonly atlasVersion: "2";
    /** Carrier-neutral active-configuration descriptor (today: XState's
     *  state value object, e.g. { socratic: { teaching: "$wait" } }). */
    readonly value: JsonValue;
    /** Root context, synthetic slots included. */
    readonly context: JsonValue;
};
```

- **Save**: `startAgent` derives `{ value, context }` from
  `getPersistedSnapshot()` instead of storing the whole blob (which also
  carries `children`/`status` internals Atlas neither needs nor wants to own).
- **Restore**: `startAgent` synthesizes the carrier snapshot the engine needs
  from the v2 payload (`{ status: "active", value, context, children: {} }` —
  the minimal shape XState v5's `restoreSnapshot` accepts). Entry actions do
  not re-run, so compound locals survive (spec 009 contract). Persistence is
  the turn-based parked case (spec 009: one event per turn → persist while
  parked in `$wait`, where the carrier holds no children); a snapshot captured
  mid-`$run` is out of scope — see Clarification C9.
- **Versioning**: `atlasVersion` moves from dead stamp to real dispatch key.
  Version `"1"` payloads → mismatch path (see Clarification C2).
- `AgentSnapshot.persisted` is typed `PersistedAgentSnapshot` — an exported
  opaque brand (Clarification C5); consumers store it without seeing inside.

### Seam 3 — Atlas IR + `xstateBackend`

New internal module pair; no public surface change:

```
defineMode/defineCompoundMode ──► lowering (compile, lowerMode, contextLift, injectEnd)
                                        │  produces
                                        ▼
                                   ir.ts  (Atlas vocabulary, zero xstate)
                                        │  consumed by
                                        ▼
                              xstateBackend.ts  (ONLY module that knows
                                        │        XState config vocabulary)
                                        ▼
                              startAgent.ts (ONLY module that imports createActor)
```

- `ir.ts` — Atlas-vocabulary node/edge types, all functions plain:
  `ModeNode { startsParked, behavior, awaitedEvents, contextLift }`,
  `CompoundNode { initial, children, contextLift }`,
  `OutcomeEdge { bucket, guard?, patch?, target | END | RE_THROW }`,
  `ErrorEdge { ... }`. Guards are `(payload, context) => boolean`; patches are
  `(context, event) => Partial<context>`; `RE_THROW`/omitted-error become a
  first-class `abort` instruction instead of a throw smuggled inside `assign`.
  No `invoke`, no `assign`, no `reenter`, no `meta`, no `$`-prefixed names.
- `xstateBackend.ts` — serializes IR → `setup().createMachine` config. Owns,
  exclusively: the `$run`/`$wait` mini-compound synthesis, `$end_*` final
  injection and sentinel rewriting, the `meta.atlasAwaiting` channel (shared
  constant with `startAgent`'s reader — today it is a magic string in two
  files, `buildActiveState.ts:368-371` / `startAgent.ts:151-160`), the
  `looseSetup` cast, the done/error event-shape reads
  (`readDoneOutput`/`readInvokeError` — collapsing the ~14 scattered
  `event as unknown as {...}` casts), `assign`/`fromPromise` wrapping, and the
  actor-name registry.
- After this phase, `grep "from \"xstate\""` over `src/` matches exactly two
  files: `xstateBackend.ts` and `startAgent.ts`.
- This phase is **behavior-preserving by definition** and is verified by the
  existing suite running unchanged against the new pipeline. It also absorbs,
  structurally, the audit's duplication findings in the lowering layer (the
  ~240-line compound-route duplication between `compile.ts:313-552` and
  `buildActiveState.ts`/`contextLift.ts` collapses because both lower to the
  same IR edge type).

### Hardening — dependency and contract tests

- `package.json`: xstate leaves `peerDependencies`, enters `dependencies`
  with a narrowed range (Clarification C3 picks it). README install
  instructions drop the explicit xstate step; `keywords`/description keep or
  drop "xstate" per Clarification C6.
- New `test/carrierContract.test.ts` pinning the three P20 behaviors against
  the installed xstate. These tests are the tripwire for any future xstate
  bump — and, later, the acceptance tests for any engine swap.

## Phasing

Each phase ships independently, in order of (value ÷ risk):

| Phase | Content | Risk | Public impact |
| --- | --- | --- | --- |
| 1 | Contract tests (P20) + dependency move (P19) | trivial | install contract only |
| 2 | `Agent` opaque handle + JSDoc scrub (P18) | low | breaking type change (alpha) |
| 3 | Owned snapshot payload, `atlasVersion: "2"` (P21) | medium | breaks persisted alpha sessions |
| 4 | IR + `xstateBackend` split (P22) | medium-high, internal | none |

Phase 4 is the largest and lands last so the contract tests and the suite
(phases 1–3) are already guarding it.

## Out of scope

- **Replacing XState.** Explicitly not this spec. The flip conditions recorded
  in the audit (observed-behavior drift upstream, durable time-based
  abandonment becoming core, XState 6 forcing a migration anyway) would each
  reopen the question via a new spec. After 012, that spec's implementation
  cost is `xstateBackend.ts` + `startAgent.ts` + a snapshot-version bump.
- The philosophy-gap features (first-class `tools`, declarative abandonment
  criterion, `settled()`/`runTurn` awaitable) — separate specs; they layer on
  top of this one cleanly.
- The pre-spec-011 dead-code/stale-test cleanups and the `tsconfig.test.json`
  typecheck gate — behavior-preserving maintenance; no spec needed, but
  recommended to land **before** phase 4 so the suite actually guards it.

## Design decisions (proposed)

- **DD-030** — `Agent` is an opaque brand; XState types never appear in public
  signatures. Supersedes the "deliberate tradeoff" comment at
  `defineAgent.ts:6-9` and amends DD-027's boundary: hosts interact with
  Atlas-branded values only, *including* the compiled machine.
- **DD-031** — xstate is an implementation dependency, not a peer. Consumers'
  manifests never mention it.
- **DD-032** — Atlas owns the persisted snapshot schema; the carrier's
  persistence format never reaches durable storage. `atlasVersion` is the
  dispatch key.
- **DD-033** — Below `startAgent`, exactly one module may know XState's
  vocabulary (`xstateBackend.ts`). The lowering pipeline targets the Atlas IR.
- (DD-029 is reserved by spec 011's mini-compound desugaring and stays as-is;
  the mini-compound becomes an `xstateBackend` concern under DD-033.)

## Verification

- Existing 240-test suite green and unchanged through every phase (phase 4's
  definition of done).
- New contract tests (P20) green against the pinned xstate range.
- Type-level: `startAgent` inference round-trip (`defineAgent` → `startAgent`
  → `send` rejects undeclared event types); cross-agent snapshot restore
  rejected; `Agent` brand not constructible by hand. Requires the typecheck
  gate fix (tsconfig covering `test/`) or these assertions are vacuous.
- Snapshot: JSON round-trip test — persist mid-compound while parked,
  stringify/parse, restore, assert mode path + compound local + `$event`
  survive and entry actions did not re-run (this test is also the missing
  spec-009 coverage flagged by the audit).
- Boundary: a lint/CI grep asserting `from "xstate"` appears only in
  `xstateBackend.ts` and `startAgent.ts` under `src/`.

## Clarifications

- **C1 (settled 2026-06-12) — Breaking-change policy for the `Agent` handle.**
  Clean break. No `unwrapAgent` escape hatch. Alpha carries no
  backward-compatibility commitments; anyone feeding `defineAgent`'s output to
  raw `createActor` stops typechecking, by design.
- **C2 (settled 2026-06-12) — Version-"1" snapshots on restore.** Option (a):
  payloads stamped `atlasVersion: "1"` (snapshots persisted by hosts running
  current alpha releases) hit the existing mismatch path — soft reset to
  `initial`. No migration helpers, consistent with spec 009 (:360-361); alpha
  makes no cross-version snapshot-compatibility promises.
- **C3 (settled 2026-06-12) — Dependency range for xstate.** `~5.31`. Every
  minor bump is a deliberate PR validated by the P20 contract tests.
- **C4 (open) — Does phase 4 subsume the lowering-duplication refactors or do
  they land first?** Landing the pure-refactor dedup first shrinks phase 4's
  review surface but does the same work twice in places. Recommendation:
  dead-code removal + test-gate fix first (small, independent), duplication
  collapse inside phase 4.
- **C5 (settled 2026-06-12) — Public type of `persisted` after v2.** Exported
  opaque branded `PersistedAgentSnapshot` — hosts can type their storage layer
  without seeing inside the payload.
- **C6 (settled 2026-06-15) — npm metadata.** Drop it. XState is an
  implementation detail after containment; the package description loses the
  "on top of XState v5" fragment and `keywords` loses `"xstate"`
  (`package.json:4,37-46`). The generic `"state-machine"` keyword stays — it
  describes Atlas's own mental model (CLAUDE.md), not the carrier.
- **C7 (settled) — Engine replacement.** Out of scope; recorded decision
  stands. This spec only restores the "easy refactor" property.
- **C8 (settled) — Inspection/`awaiting`/`onError` surfaces.** Unchanged by
  this spec; `meta.atlasAwaiting` becomes a shared named constant and an
  `xstateBackend` concern, with identical observable output.
- **C9 (settled 2026-06-15) — Restore of a mid-`$run` snapshot.** Out of scope.
  The v2 payload is `{ value, context }` only; on restore Atlas synthesizes a
  carrier snapshot with `children: {}`. Verified against `xstate@5.31.1`: for
  the parked (`$wait`) case — the turn-based persistence contract (spec 009:
  one event per turn, persist between turns) — the carrier holds no children,
  so v2 restore is **bit-identical** to the old v1 full-blob restore. The two
  diverge **only** if a host persists while a `$run` behavior is mid-flight:
  v1's blob restarts the invoke, v2's empty children does not (the behavior
  would not resume). This contradicts the draft's earlier "behaviors of
  `$run`-active modes restart" wording, now corrected. Reconstructing active
  invokes on restore would require carrier-specific child-id synthesis in
  `startAgent` — fragile and properly an `xstateBackend` concern (DD-033) —
  and buys nothing for the documented turn-based model. Spec 009 already lists
  "Invoked child actors: No" and "Pending events queued mid-turn: No" as
  non-surviving, so this is consistent, not a regression of any stated
  guarantee.
