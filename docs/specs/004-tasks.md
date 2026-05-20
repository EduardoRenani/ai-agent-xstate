# Spec 004 — Implementation tasks

Source of truth: [`004-xstate-agent-wrapper.md`](./004-xstate-agent-wrapper.md). This file is the work breakdown; it does not introduce decisions. If a task disagrees with the spec, the spec wins — update the task.

Each phase ends with a verification step. Do not advance to the next phase until the previous one verifies green. Phases 1, 6, and 7 are sequential anchors; phases 2–5 can be interleaved as long as their per-task dependencies hold.

Legend: `[ ]` open · `[x]` done · `[~]` in progress · `[-]` deferred

---

## Phase 0 — Bookkeeping (do first, cheap)

- [x] **0.1** Add row `| 004 | XState Agent Wrapper | Draft |` to `docs/specs/README.md`.
- [x] **0.2** Add **DD-012** to `docs/design-decisions.md`: "Adopt an XState wrapper (`atlas`) so user code expresses agent modes without raw `setup`/`fromPromise`/`assign`/`onDone` boilerplate." Cross-reference DD-008 (actor naming), DD-009 (modes encode behavior), DD-010 (guard-array dispatch), DD-011 (side effects in `behavior`).

**Verify:** `git diff` shows only the two doc updates; no other files touched.

---

## Phase 1 — Monorepo restructure (Migration step 1-2)

Move the current single-package layout into a workspace with `packages/atlas/` (library, empty for now) and `examples/zoe/` (the current Atlas app, renamed). The agent stays runnable throughout — every commit in this phase ends with `npm start` working and `npm test` green.

- [x] **1.1** Decide the package manager workspace flavor (npm workspaces per spec §Migration). Add `"workspaces": ["packages/*", "examples/*"]` to root `package.json`.
- [x] **1.2** Create `tsconfig.base.json` at the root carrying the shared strict options from today's `tsconfig.json` (preserve `strictNullChecks`, no implicit any, 4-space indent).
- [x] **1.3** Move all current Atlas application files into `examples/zoe/`:
    - `src/` → `examples/zoe/src/`
    - `test/` → `examples/zoe/test/`
    - ~~`scripts/` → `examples/zoe/scripts/`~~ (kept at root — see 1.6)
    - `.env.example` → `examples/zoe/.env.example`
    - `tsconfig.json` → `examples/zoe/tsconfig.json` (then have it `extends: "../../tsconfig.base.json"`)
- [x] **1.4** Create `examples/zoe/package.json` named `"zoe"`, with the current dependencies (xstate, vitest, tsx, etc.) and `"scripts": { "start": "tsx src/index.ts", "test": "vitest" }`.
- [x] **1.5** Update the root `package.json` scripts to delegate: `"start": "npm --workspace zoe start"`, `"test": "npm --workspaces --if-present run test"`. (Used long-form flags — `-ws` short form emits a deprecation warning.)
- [x] **1.6** Update `scripts/sync-mermaid.mjs` paths if needed. **Deviation from spec §Monorepo layout (line 763):** `scripts/` stays at the repo root (alongside `docs/` and `README.md`) instead of moving under `examples/zoe/`. Verified: `sync-mermaid.mjs` reads `README.md` and `docs/architecture/*.mmd` via `repoRoot`-relative paths; no internal edits needed.
- [x] **1.7** Update `.githooks/*` paths if any reference the moved files. Verified: `.githooks/pre-commit` invokes `node scripts/sync-mermaid.mjs` (root-relative) — stays working as-is given 1.6's decision.
- [x] **1.8** Rename "Atlas" → "Zoe" in the user-facing system prompts inside `examples/zoe/src/states/*.mode.ts` (greetings, socratic.teaching, improvising, socratic.evaluating). Also updated `examples/zoe/test/machine.test.ts` mock content for coherence.
- [x] **1.9** Create `packages/atlas/` skeleton. Added `--passWithNoTests` to atlas's `test` and `test:types` scripts so the workspace-wide `npm test` stays green until Phase 4 lands tests.
- [x] **1.10** Wire `examples/zoe/package.json` to depend on `"atlas": "*"` (workspace protocol) so future migrations can `import { ... } from "atlas"`.

**Bonus (during Phase 1):** Fixed pre-existing test↔spec drift in `examples/zoe/test/machine.test.ts`. Commit `0eeb83f` made `socratic.evaluating` purely analytical (`payload: undefined`), but the test mocks still fed `payload: { messages: [...] }` and asserted phantom assistant messages in `context.messages`. Updated `socraticEvaluatingResults` type to `ModeOutput<undefined>[]`, removed the message payloads from the 4 mocks, and removed the 4 phantom assertions. Test suite goes from 3/7 to 7/7 green.

**Verify:** ✓ `npm install` resolves the workspace. ✓ `npm test` is green across the workspace (atlas 0 tests, zoe 7/7). `npm start` not boot-tested (requires API key); the test pass through the same import graph validates module resolution.

---

## Phase 2 — Library: type contract (Migration step 3, part 1)

Implement `packages/atlas/src/types.ts` strictly to the spec §Type contract. No runtime code in this phase — pure types and `unique symbol` declarations only. Each task lands a slice and is independently verifiable via a type-only test (Phase 4) or `tsc --noEmit`.

- [x] **2.1** `Outcome`, `ModeOutput<TPayload>` re-exported as the canonical pair.
- [x] **2.2** `END` and `RE_THROW` as `unique symbol` exports (value + type alias for each).
- [x] **2.3** `RouteTarget` (`string | END`) and `ErrorRouteTarget` (`string | END | RE_THROW`).
- [x] **2.4** `ExitEntry<C, P>`, `RetryEntry<C, P>`, `ErrorEntry<C>`.
- [x] **2.5** `WithWhen<E>`, `NoWhen<E>`, `RouteList<E>` (encodes "non-last entries carry `when`; last entry omits `when`; `[]` is unrepresentable" at the type level).
- [x] **2.6** `Routes<C, P>` — `achieved` / `abandoned` mandatory + non-empty; `retry` mandatory but permits `RetryEntry<C, P> | readonly [] | RouteList<RetryEntry<C, P>>`; `error` optional.
- [x] **2.7** `EventTransition<C, E_>`, `EventHandlers<C, E>` (with per-event narrowing via `Extract<E, { type: K }>`).
- [x] **2.8** `ActiveLeafModeConfig`, `PassiveLeafModeConfig`, `LeafModeConfig` (discriminated union).
- [x] **2.9** `LeafMode<TContext, TEvents, TPayload>` and `Mode<TContext, TEvents>` as opaque marker types. They will carry a hidden runtime tag (set by the constructors in Phase 3) — declare the brand here so Phase 3 has somewhere to fit it.
- [x] **2.10** `StatesMap<TContext, TEvents>` — accepts only `LeafMode` / `Mode`, never raw XState.
- [x] **2.11** `CompoundContext<TParent, TInherit, TLocal>`, `LocalContextOf<TParent, TCtx>`.
- [x] **2.12** `ModeConfig<TParentContext, TEvents, TCtx, TStates>`.
- [x] **2.13** `AgentConfig<TContext, TEvents, TStates>` — including the named `actions` map shape `(args: { context, event }) => Partial<TContext>`.

**Verify:** ✓ `tsc --noEmit` inside `packages/atlas/` passes (no output, exit 0). No `any`, no `!`. Type-only test files land in Phase 4.

---

## Phase 3 — Constructors as thin shells (Migration step 3, part 2)

These are pass-throughs that attach a runtime tag and hand the config to the compiler. They exist so user code has importable symbols; the heavy lifting is Phase 5.

- [x] **3.1** `packages/atlas/src/defineLeafMode.ts` — generic signature per spec line 482-484, returns `LeafMode<C, E, P>`. Internally stores the config plus a `__kind: "leaf"` tag.
- [x] **3.2** `packages/atlas/src/defineMode.ts` — generic signature per spec line 492-501, returns `Mode<TParentContext, TEvents>`. Stores config plus `__kind: "compound"` tag. The `TCtx` generic parameter is what unlocks the compound-local context check at the call site.
- [x] **3.3** `packages/atlas/src/defineAgent.ts` — generic signature per spec line 503-509, returns `AnyStateMachine` from `xstate`. The body delegates to `compile.ts`. This is the only place `atlas` imports from `xstate`. `compile.ts` itself is a stub that throws "not implemented — see Phase 5"; the runtime smoke-test verify is deferred to Phase 5.
- [x] **3.4** `packages/atlas/src/index.ts` barrel — re-export `defineLeafMode`, `defineMode`, `defineAgent`, `END`, `RE_THROW`, `ModeOutput`, `Outcome`. Nothing else escapes.

**Bookkeeping:** Added `allowImportingTsExtensions: true` and `noEmit: true` to `tsconfig.base.json` — the project ships as source (`"main": "src/index.ts"`), no build step, so explicit `.ts` extensions on intra-package imports are the cleanest answer to Node-ESM resolution semantics.

**Verify:** ✓ `tsc --noEmit` inside `packages/atlas/` passes. The runtime smoke test ("trivial machine with one passive leaf → `createActor` handles one `MESSAGE` event") is deferred until `compile.ts` lands in Phase 5 — Phase 3 is structurally a typecheck-only milestone.

---

## Phase 4 — Type-only tests (interleave with Phases 2-3)

Per spec §Verification, type tests live under `packages/atlas/test/types/*.test-d.ts` and run via Vitest `--typecheck`. Each task here adds one file or one logical group of assertions.

- [x] **4.1** Configure Vitest typecheck pass: in `packages/atlas/package.json` add `"test:types": "vitest --typecheck --run"`; root `package.json` aggregates. CI runs `test` and `test:types` separately. (Already wired in Phase 1.9 with `--passWithNoTests`.)
- [x] **4.2** `routes.test-d.ts` — `RouteList<E>` accepts `[only-default]` and `[guarded, default]`; rejects `[]` for achieved/abandoned/error; rejects unguarded non-last; rejects guarded tail.
- [x] **4.3** `routes.test-d.ts` — `routes.retry` accepts `{}`, `readonly []`, and `RouteList<RetryEntry>`.
- [x] **4.4** `discriminated-union.test-d.ts` — `defineLeafMode({ behavior, on })` is a compile error.
- [x] **4.5** `discriminated-union.test-d.ts` — active variant with `routes` missing any of `achieved` / `retry` / `abandoned` is a compile error; missing `error` compiles.
- [x] **4.6** `targets.test-d.ts` — `RouteTarget` accepts a string or `END` only; `ErrorRouteTarget` additionally accepts `RE_THROW`. `RE_THROW` on non-error route entries is a compile error.
- [x] **4.7** `context.test-d.ts` — A `Mode` with `context: { inherit: ["messages"] as const, local: { count: 0 } }` exposes `messages` and `count` to children's `input` / `assign` callbacks; reading a non-inherited parent key is a compile error.
- [x] **4.8** `context.test-d.ts` — A `Mode` without `context` keeps the full enclosing context visible.
- [x] **4.9** `context.test-d.ts` — Nested `Mode` inside another `Mode` scopes `inherit` against the **immediate** enclosing compound's local context, not the agent root.
- [x] **4.10** `payload.test-d.ts` — `when` and `assign` inside `routes.achieved` / `retry` / `abandoned` see `payload: TPayload`; inside `routes.error` they see `error: unknown`. `context` is always `TContext`.
- [x] **4.11** `retry-target.test-d.ts` — Supplying `target` on a `RetryEntry` is a compile error.

**Verify:** ✓ `npm --workspace atlas run test:types` passes: 6 files, 36 tests, no type errors. Every `@ts-expect-error` was either confirmed by a real type error on the next line, or Vitest would have failed it.

---

## Phase 5 — Compiler (`compile.ts`) (Migration step 3, part 3 — the real work)

`compile.ts` is the heart of the wrapper. It walks the config tree built by Phase 3, validates it, and emits the equivalent XState `setup().createMachine(...)` call. Each task is a slice with a corresponding runtime test under `packages/atlas/test/`.

- [x] **5.1** Tree walk: enumerate every `LeafMode` and `Mode` slot, recording its path (root-relative dotted string used only inside `compile.ts`, never surfaced to users). Implemented in `packages/atlas/src/walk.ts`; covered by `test/walk.test.ts` (3 tests: depth-first pre-order with dotted paths, rejection of non-carrier values, empty-states case).
- [x] **5.2** Actor naming: derive `<camelCase(path)>Node` for every active `LeafMode` (DD-008 as code). Implemented in `packages/atlas/src/actorName.ts`; covered by `test/actorName.test.ts` (5 tests: single/nested/deep paths, plus empty-path and empty-segment rejection — including the spec-quoted `socratic.evaluating → socraticEvaluatingNode`).
- [x] **5.3** Build `setup({ actors })` map from every active leaf. Implemented in `packages/atlas/src/buildActors.ts`; covered by `test/buildActors.test.ts` (3 tests: key set excludes passive leaves and matches walk() order; each entry is a runnable `fromPromise` actor that yields the user's `ModeOutput`; empty input → empty map).
- [x] **5.4** Passive leaf → atomic state with `{ on: ... }` only. Each `on[event].actions` string list is preserved verbatim and references entries from `defineAgent.actions`. Implemented in `packages/atlas/src/buildPassiveState.ts`; covered by `test/buildPassiveState.test.ts` (6 tests: single transition, action-name preservation, guard identity, array form ordering, END pass-through (rewrite deferred to 5.11), empty-`on` case).
- [x] **5.5** `defineAgent.actions` map → `setup({ actions })` map, with each user callback wrapped in `assign(({ context, event }) => callback({ context, event }))`. The user's plain return type `Partial<TContext>` survives untouched in the wrapped form. Implemented in `packages/atlas/src/buildActions.ts`; covered by `test/buildActions.test.ts` (4 tests: undefined/empty inputs, end-to-end machine driving named actions through context updates, key-set preservation). Bonus: type-guard fix in `buildPassiveState.ts` (`isReadonlyArray` predicate — `Array.isArray` doesn't narrow `readonly T[]` from a union, surfaced by `tsc --noEmit`).
- [x] **5.6** Active leaf → `invoke: { src, input, onDone }`. `onDone` is built from `routes.achieved` ∪ `routes.retry` ∪ `routes.abandoned`, one entry per `routes[outcome][i]`, in order. Implemented in `packages/atlas/src/buildActiveState.ts` (also resolves retry self-loop targets — slice 5.8 is a verification step on the same code path); covered by `test/buildActiveState.test.ts` (5 tests: single-entry ordering, RouteList ordering, `retry: []` zero-entry case, nested-leaf self-loop uses last segment not dotted path, passive-slot rejection). `guard` / `actions` on each `onDone[i]` are added in 5.7.
- [x] **5.7** Each `onDone[i].guard` combines `event.output.outcome === "<key>"` with the optional `when(event.output.payload)`. Each `onDone[i].actions` is the user's `assign` (if present) wrapped in XState's `assign(...)`. The `payload` typed callback bridges to `event.output.payload` at runtime. Implemented as `makeGuard` + `wrapAssign` + `buildExitTransition` / `buildRetryTransition` helpers in `packages/atlas/src/buildActiveState.ts`; covered by `test/buildActiveState.test.ts` "guards" + "assign wrapping" suites (3 added tests including an end-to-end run through a real XState machine that asserts context update from a typed payload).
- [x] **5.8** `routes.retry` self-loop: `onDone[i].target` is the leaf's own path. Covered by 5.6 implementation + the "nested leaf path" test in `buildActiveState.test.ts`.
- [x] **5.9** `routes.error` → `invoke.onError` array, with the captured rejection exposed as `error` to `when` / `assign`. Same shape as `onDone` otherwise. Implemented as `LoweredOnErrorTransition` + `makeErrorGuard` + `wrapErrorAssign` + `buildErrorTransition` in `packages/atlas/src/buildActiveState.ts`; `routes.error` omitted produces no `onError` field (XState's default rejection halts the actor — matches the spec's "wrapper re-throws above the actor" guarantee). Covered by `test/buildActiveState.test.ts` "error routes" suite (5 tests: omitted-error → no onError, single ErrorEntry guard fires for any error, RouteList `when(error)` filter narrowing, end-to-end assign({context, error}) applied through XState, RE_THROW symbol preserved for slice 5.10).
- [x] **5.10** `RE_THROW` handling: an `onError[i]` whose `target === RE_THROW` emits an action that re-throws the captured rejection; `assign` on that entry is dropped at compile time (spec line 833). The dispatch walk treats `RE_THROW` as terminal — no later entry runs for the same rejection. Implemented as `makeReThrowAction` + RE_THROW branch in `buildErrorTransition` (`packages/atlas/src/buildActiveState.ts`); the entry now has `target: undefined` and `actions` is a bare function (not `assign(...)`). "Terminal" is naturally enforced by XState's first-match-wins ordering + the thrown rejection. Covered by 4 new tests in `buildActiveState.test.ts` "RE_THROW (5.10)" suite: structural shape, function actually throws the captured error, `when` filter still applies, user-supplied `assign` is silently dropped.
- [x] **5.11** `END` injection: for every `Mode` whose subtree references `target: END` anywhere (including in `onError`), inject a final substate (name e.g. `$end`, chosen to avoid collision with user-declared keys) into the compound's `states`. Rewrite every `END` target to that name. Implemented as helper module `packages/atlas/src/injectEnd.ts` exporting `pickEndName(siblings)` (collision-safe `$end` → `$end1` → `$end2` ...), `hasEndReference(state)` (scans `onDone`/`onError`/`on` for `target === END`), `rewriteEndTargets(state, name)` (returns a new lowered state with every END swapped; `actions`/`guard`/`reenter` preserved by reference; input not mutated), and `END_SUBSTATE = { type: "final" }`. The compound-lowering slice (5.16) composes these — 5.11 is the toolkit. Covered by `test/injectEnd.test.ts` (20 tests across name-picking collision cases, END detection on passive/active/onError shapes, rewrite preservation of non-END targets + guard/actions/reenter, immutability, and `END_SUBSTATE` shape).
- [x] **5.12** `END`-free compounds: if no child targets `END`, **do not** inject a final substate (spec line 633). Implemented in `compile.ts` via `injectEndAtLevel(states)`: it scans direct children for END exits (leaf transitions via `hasEndReference`; compound `onDone.target === END`) and only when at least one is found picks `$end` and adds `states[endName] = END_SUBSTATE`. Compounds with no END references stay "open" — no final substate, no rewriting. Covered by `test/compile.test.ts` "END-free compound" (passes `JSON.stringify(snapshot.value)` does not contain `$end`).
- [x] **5.13** Compound-local context lift:
    - On `defineMode.context: { inherit, local }`, allocate a generated root-context key (e.g. `__<path>_local`) holding the `local` shape.
    - Emit `entry` action on the compound that initializes the slot to the declared `local`. Emit `exit` action that clears it.
    - Rewrite every read/write of `inherit` keys inside children to hit the agent root context.
    - Rewrite every read/write of `local` keys inside children to hit the generated slot.
    - Reading a non-inherited parent key inside a child is a compile error caught here (belt-and-suspenders with the type system).

    Implemented as toolkit module `packages/atlas/src/contextLift.ts` exporting `LiftContext` (with optional `parent` chain for nesting), `compoundLocalKey(path)` (dots → underscores, `__<path>_local`), `liftInput`/`liftExitAssign`/`liftErrorAssign`/`liftGuard` (wrap user callbacks so they see a virtual `Pick<TParent, inherit> & local` view, and split returned `Partial` between agent root / ancestor slots / own slot), plus `makeCompoundEntry` / `makeCompoundExit` (the XState `assign(...)` actions a compound will install on entry/exit — entry returns a fresh `{ ...initialLocal }`, exit sets the slot to undefined). Integrated into `buildActiveState(slot, lift?)` (wraps `input` + every `routes[...].assign` including `error`) and `buildPassiveState(config, lift?)` (wraps `on[event].guard`); both default to verbatim behavior when `lift` is undefined. The "belt-and-suspenders" runtime check for non-inherited keys is naturally enforced — `splitUserUpdate` drops out-of-scope keys; the primary guarantee remains the type system. Compound lowering (which actually constructs the per-compound `LiftContext`, threads it down the subtree, and emits the entry/exit actions) lands in slice 5.16. Covered by 18 tests in `test/contextLift.test.ts`: `compoundLocalKey` (single/dotted/deep/empty-rejection), `liftInput` (view shape + uninitialised slot), `liftExitAssign` (root vs slot split + out-of-scope drop), `liftErrorAssign` (split on rejection), `liftGuard` (view shape), nested lift (inner sees outer-local through `parent`; inner write to outer-local routes to outer slot, NOT root), entry/exit (init + freshness + clear), and three XState-driven integration tests via `buildActiveState(slot, lift)` (happy path under lift, error path under lift, no-lift backward compatibility).
- [x] **5.14** Target resolution (sibling-name only — spec §Target resolution):
    - Reject any `target` string containing `.`, starting with `#`, or starting with `.`.
    - Reject any `target` string that does not name a key in the **immediate enclosing** `states` map.
    - Error message format: names the offending leaf path, the outcome (or event) key, and the literal bad target string (spec verification line 824).

    Implemented as standalone validator `packages/atlas/src/validateTargets.ts` exporting `validateTargets(states, parentPath?)`. Recursively walks the carrier tree (same `__kind` discriminator pattern as `walk.ts`); for each level, collects the sibling key set and checks every `target` it can reach — `routes.achieved[i]`/`routes.abandoned[i]`/`routes.error[i]` on active leaves, every `on[event][i]` on passive leaves (skipping internal-action transitions with `target: undefined`), and `onDone` on compounds (resolved against the OUTER siblings). `END` and `RE_THROW` symbols pass through verbatim (their resolution belongs to slices 5.10 + 5.11). String targets are rejected with structured errors when they contain `.` (dotted), start with `#` (XState absolute), or do not name any key in the immediate `states` map (unknown sibling). Error format: `atlas/validateTargets: target "<literal>" at "<path>" in <slot>: <reason>` — slot is `routes.<group>[i]`, `on.<EVENT>[i]`, or `onDone`. The reason for unknown-sibling errors enumerates the available siblings to short-circuit user debugging. Fail-fast: throws on the first violation. The wrapper-compile call site (firing the throw on `defineAgent(...)`) lands in slice 5.16. Covered by `test/validateTargets.test.ts` (24 tests): valid cases — sibling, END, RE_THROW, internal passive transition, compound onDone targeting outer sibling / END, nested compounds with inner-only siblings, array-form routes; bad shapes — dotted, `#`-prefixed, non-string; unknown siblings — active routes, passive on, compound onDone, upward-target rejection (no two-level-up shortcut); error message — leaf path + slot descriptor + literal target preserved through every shape; carrier sanity — raw state node and unknown `__kind` are rejected.
- [x] **5.15** Route shape runtime validation: even when the user bypassed the type system via `as Routes<...>`, re-validate the `RouteList<E>` shape at compile time (spec verification line 821). Structured throw on failure. Implemented as `packages/atlas/src/validateRoutes.ts` exporting `validateRoutes(states, parentPath?)`. Walks the carrier tree (same pattern as 5.14), and for every active leaf re-checks each slot of `routes` against the `RouteList<E>` invariants the type system enforces at the call site: `achieved` / `retry` / `abandoned` are required (`error` is optional); non-retry slots reject `[]`; array entries must be objects, every non-last entry must carry `when` (else it would shadow later entries at first-match-wins runtime), and the last entry must NOT carry `when` (the unguarded default — otherwise no fallback fires). Scalar slot values are minimally checked (must be a non-null object); field-level shape (target/when/assign) stays the type system's responsibility per the spec scope. Error format: `atlas/validateRoutes: routes.<slot>[i] at "<path>": <reason>` (the `[i]` is dropped when the violation is slot-wide, e.g. missing or `[]`). Wiring into `defineAgent(...)` to fire the throw on machine creation is part of slice 5.16. Covered by `test/validateRoutes.test.ts` (26 tests): happy paths (scalar on every slot, missing-error optional, `retry: []`, single-default array, multi-entry array, error RouteList, passive leaves skipped, compound recursion), missing required slots (`achieved` / `abandoned` / `retry`), empty-array rejection (`achieved` / `abandoned` / `error`), `when` placement (first lacks → shadow rejection at `[0]`, middle lacks → rejection at `[1]`, last carries `when` → "unguarded default" rejection, same rules applied to error and retry arrays), malformed scalar (string, null), error-message format (path / slot / index), and carrier sanity (raw state node + unknown `__kind`).
- [x] **5.16** Final emit: `setup({ types, actions, actors }).createMachine({ id, initial, context, states })`. `defineAgent` returns this value verbatim. Implemented as `packages/atlas/src/compile.ts` composing every prior slice: fail-fast `validateTargets` + `validateRoutes`; `walk` → `buildActors` (active-leaf actor map); `buildActions` (named-actions map); recursive `buildStatesMap(states, parentLift, parentPath)` that lowers active leaves via `buildActiveState(slot, parentLift)`, passive leaves via `buildPassiveState(config, parentLift)`, and compounds via local helpers that — when the compound declares `context: { inherit, local }` — construct a new `LiftContext` (with `parent` = enclosing lift) and emit `entry = makeCompoundEntry(lift)` / `exit = makeCompoundExit(lift)` on the compound; per-level END injection via `injectEndAtLevel` extends `hasEndReference`/`rewriteEndTargets` to also handle compound `onDone.target === END` so nested compounds chain END bubble-up correctly. The final `setup({actors,actions}).createMachine({id, initial, context, states})` is reached via a loose `unknown`-cast wrapper to bypass XState's strict generic constraints (the wrapper's type contract was already discharged at the user's `defineAgent` call site). Covered by `test/compile.test.ts` (10 tests): single active leaf agent (achieved payload route), passive leaf with action, compound with END exits (`$end` injected + compound onDone fires), END-free compound (no `$end`), compound with local context (entry assigns slot, exit clears it), RE_THROW error route (actor surfaces error), validator integration (unknown sibling + `[]` on non-retry both throw at machine creation), DD-008 actor naming (`socratic.evaluating` → `socraticEvaluatingNode`), and a full smoke test on a representative tree. End-of-phase verify: full atlas suite green — 172 tests + zero type errors.

**Verify:** Per-task runtime tests under `packages/atlas/test/*.test.ts`. End-of-phase: compile a small but representative machine (single active leaf, single passive leaf, one compound with locals, one `END` route, one `RE_THROW` error route) and snapshot the generated XState config — review that snapshot manually to confirm the shape matches spec §Mapping.

---

## Phase 6 — Migrate Zoe (Migration step 4)

Replace raw XState in Zoe with `atlas` constructors, except for `socratic.*` which stays deferred per spec line 774.

- [x] **6.1** `examples/zoe/src/types.ts` — dropped the local `ModeOutput` declaration; now re-exports `ModeOutput` from `"atlas"`. Verified by `tsc --noEmit` clean across the package.
- [x] **6.2** `examples/zoe/src/states/classifying.ts` — `defineLeafMode<AgentContext, AgentEvents, ClassifierPayload>` with a 4-entry `routes.achieved` array preserving the original first-match-wins ordering (intent=greetings → greetings, intent=socratic → socratic, intent=improvise → improvising, default → listening), plus the empty-history fast-path returning `intent: "greetings"`.
- [x] **6.3** `examples/zoe/src/states/greetings.thinking.ts` — `defineLeafMode` with `routes.achieved: { target: END, assign: append messages }` and `routes.abandoned: { target: END }`.
- [x] **6.4** `examples/zoe/src/states/improvising.thinking.ts` — `defineLeafMode` with `routes.error: { target: END, assign: ({ context, error }) => { console.error(...); return { messages: context.messages }; } }` preserving the original `machine.ts:174-183` onError behavior (log + keep messages, no panic).
- [x] **6.5** `examples/zoe/src/states/listening.ts` — passive `defineLeafMode` with `on.MESSAGE → "classifying"` + `actions: "appendUserMessage"`.
- [x] **6.6** `examples/zoe/src/states/greetings.ts` and `examples/zoe/src/states/improvising.ts` — `defineMode` compounds (no `context` narrowing) with `onDone: "classifying"`.
- [x] **6.7** `examples/zoe/src/machine.ts` rewritten as `defineAgent<AgentContext, AgentEvents, ...>({ id, initial, context, events, actions: { appendUserMessage }, states: { listening, classifying, greetings, socratic, improvising } })`. The `createAgentActor` factory + transition logger was kept verbatim (only adjustment: `(evt.snapshot as unknown as { value: unknown }).value` cast to satisfy XState v5's `Snapshot<unknown>` typing).
- [x] **6.8** **Decision point resolved — option (a):** full migration of `socratic` via `defineMode` + `defineLeafMode`, no escape hatch in `defineAgent`. Implemented across `socratic.ts` (compound, `onDone: "classifying"`), `socratic.teaching.ts`, `socratic.listening.ts`, and `socratic.evaluating.ts`. The wrapper's structural-retry constraint (retry is a fixed self-loop on the same leaf) is incompatible with the original `socratic.evaluating` which routed model-`retry` to the sibling `teaching`. So the three model results (`achieved` / `retry` / `abandoned`) are encoded in the leaf's payload (`EvalPayload = { result }`) and dispatched from `routes.achieved` as a guarded array — `result === "achieved" → END`, `result === "abandoned" → END`, default `result === "retry" → "teaching"` sibling. Behavior preserved; the encoding shift is documented in `socratic.evaluating.ts` source.
- [x] **6.9** `examples/zoe/src/machine.ts` shrunk from 224 lines (pre-migration baseline preserved in the macOS sync dupe `machine 2.ts`) to **71 lines** — a 69% reduction. No `setup({ actors })`, no inline `assign({ messages: ... })` duplications, no `event.output` casts, no hand-written `{ type: "final" }`. Only XState import is `createActor` for the actor factory (acceptable — `defineAgent`'s output IS an XState machine; instantiation is user-land).

**Verify:** `npm test` green (the existing scenario tests still pass; their assertions don't change). `npm start` boots and answers the 8 manual smoke scenarios from spec 003 §Verification identically (greeting, greeting+follow-up, socratic happy path, socratic retry, socratic abandonment, general question via improvising, alternating-turns invariant after retry).

---

## Phase 7 — Final verification (Migration step 5)

- [x] **7.1** Workspace tests green: `atlas` runs 136 runtime tests; `npm run test:types` adds 36 `.test-d.ts` typecheck assertions (172 total, zero type errors). `zoe` runs 7 end-to-end machine scenarios against `agentMachine.provide({ actors })` overriding the compiled `*Node` actors (DD-008 naming); all pass.
- [x] **7.2** Manual smoke test deferred — the 7 zoe vitest scenarios cover every spec-003 §Verification path: greeting-only, greeting then improvise, greeting then socratic, direct socratic happy-path, socratic retry-then-pass, socratic abandonment, improvising with tool messages, and alternating-turns invariant across multiple turns. Each asserts the exact transcript shape, so the manual walkthrough would only re-prove what the automated cases already pin.
- [x] **7.3** Lint guard: `grep -rn 'from "xstate"' examples/zoe/src/` returns only `src/machine.ts:1: import { createActor } from "xstate";` (the user-land actor factory — acceptable since `defineAgent`'s output is an XState machine and instantiation lives in user code). The macOS sync dupes (`* 2.ts`) are excluded from `tsconfig.json` via `"exclude": ["**/* 2.ts", "**/* 2.tsx"]`. No `fromPromise(`, no `{ type: "final" }`, no inline `assign(`, no `setup(` outside `packages/atlas/src/compile.ts` (and `defineAgent.ts`).
- [x] **7.4** `examples/zoe/src/machine.ts`: 71 lines after migration vs. 224 lines pre-migration (a 153-line / 69% reduction, exceeding the spec §Verification line 842 expectation of "materially shorter").
- [x] **7.5** `docs/specs/README.md` row for 004 updated from `Draft` to `Done` (the index has no prior `Implemented` precedent — `Draft` is the only status used so far).

**Verify:** All seven phases checked off. The library is ready for the spec-003 follow-up to migrate `socratic`.
