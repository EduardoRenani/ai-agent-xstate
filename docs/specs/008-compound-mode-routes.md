# 008 — Compound Mode Routes

## Status

Done.

## Goal

Give `CompoundMode` the same routing surface as `Mode`. Today a compound exits
through a single `onDone: RouteTarget` — only one destination after the compound
completes. Replace it with `routes: CompoundRoutes<TContext, TPayload, TDeps>`,
the same shape `Mode` already uses, so the compound can dispatch on outcome
(and optionally payload) just like a leaf.

The user-visible mental model becomes: **`Mode` and `CompoundMode` share format
and dynamics. The only difference is the body** — a `Mode`'s body is an actor
(`input` + `behavior`), a `CompoundMode`'s body is a set of sub-modes (`modes`,
`initial`, optional `context`, optional `output`).

## Problems Addressed

### P10 — Compound mode can only exit to one destination

`packages/atlas/src/types.ts:613` declares `onDone: RouteTarget`. After a child
routes `END`, the compound has no way to discriminate destinations by which
outcome the child produced. The workaround in
`examples/zoe/src/states/socratic.evaluating.ts:55-67` encodes three possible
outcomes in `payload.result` and dispatches *inside* the evaluating leaf —
pushing routing logic that conceptually belongs at the compound level down into
one of its children, and forcing every future compound to repeat the same
trick whenever it has more than one exit destination.

### P11 — `CompoundMode` is the only Mode-kind without `Routes`

DD-002 ("each state is a mode") and spec 006 ("Modes, Not States") establish
that the two kinds — leaf and compound — are facets of one concept. The
constructors mirror each other (`defineMode` / `defineCompoundMode`), the
brands mirror each other (`Mode` / `CompoundMode`), the `modes` slot accepts
both interchangeably. The exit shape is the last asymmetry: a single `onDone`
vs the four-bucket `routes`. After this spec the surface is symmetric.

## Public API Changes

### `CompoundModeConfig`

```ts
export type CompoundModeConfig<
    TParentContext,
    TEvents extends { type: string },
    TCtx extends
        | CompoundContext<TParentContext, ReadonlyArray<keyof TParentContext & string>, object>
        | undefined,
    TModes extends ModesMap<LocalContextOf<TParentContext, TCtx>, TEvents, TDeps>,
    TPayload = undefined,                              // NEW
    TDeps extends Record<string, unknown> = Record<string, never>,
> = {
    context?: TCtx;
    initial: keyof TModes & string;
    modes: TModes;
    // Optional payload producer. Called when any child routes to END, after
    // the child's `assign` has run. Sees the compound's effective context
    // (LocalContextOf<TParentContext, TCtx>) plus deps. The returned value
    // becomes `event.output.payload` on the parent's onDone dispatch.
    // When omitted, the compound emits payload = undefined and `routes`'
    // `when(payload)` callbacks see `undefined`.
    output?: (args: {
        context: LocalContextOf<TParentContext, TCtx>;
        deps: TDeps;
    }) => TPayload;
    // REPLACES `onDone`. Same shape Mode already uses, minus the optional
    // `error` bucket — compound errors are produced by children's
    // `routes.error`, not by a compound-level callback (see "Error outcome"
    // below).
    routes: CompoundRoutes<TParentContext, TPayload, TDeps>;
};
```

### `CompoundRoutes`

```ts
// Same as `Routes<C, P, D>` from spec 004 with two differences:
// 1. `retry` is constrained to `readonly []` only — children cannot bubble
//    `retry` (RetryEntry has no `target`), so the bucket exists for shape
//    symmetry with `Mode.routes` but never fires from a child.
// 2. `error` is OPTIONAL with the same semantics as `Mode.routes.error`:
//    when omitted, an `END` rooted inside a child's `routes.error` re-throws
//    above the compound (matches today's "loud failure" default).
export type CompoundRoutes<
    TContext,
    TPayload,
    TDeps extends Record<string, unknown> = Record<string, never>,
> = {
    achieved:
        | ExitEntry<TContext, TPayload, TDeps>
        | RouteList<ExitEntry<TContext, TPayload, TDeps>>;
    retry: readonly [];                              // shape-only
    abandoned:
        | ExitEntry<TContext, TPayload, TDeps>
        | RouteList<ExitEntry<TContext, TPayload, TDeps>>;
    error?:
        | ErrorEntry<TContext, TDeps>
        | RouteList<ErrorEntry<TContext, TDeps>>;
};
```

### Outcome propagation rules

The compound's outcome is **whichever bucket of the exiting child** contained
the `END` target. No new syntax in the leaf — `target: END` keeps its current
meaning. The bucket name (`achieved` / `abandoned` / `error`) names the
compound's bubble outcome.

| Exit site in a child                       | Compound's bubble outcome |
| ------------------------------------------ | ------------------------- |
| `routes.achieved[i].target = END`          | `achieved`                |
| `routes.abandoned[i].target = END`         | `abandoned`               |
| `routes.error[i].target = END`             | `error`                   |
| `on[event].target = END` (passive leaf)    | `achieved` (default)      |

Children **cannot** bubble `retry` — `RetryEntry` has no `target` field
(DD-014), so retry is structurally impossible to route to `END`. The
compound's `routes.retry` therefore exists only as `readonly []` (shape
symmetry; the slot never fires).

Passive `on[event].target = END` defaults to bubbling `achieved`. This is the
natural reading ("we finished waiting, end the compound") and matches the
common case (greetings/improvising's single-substate compounds today).
Explicit override is **out of scope** for this spec — if a passive event needs
to bubble `abandoned`, the handler routes to a leaf that does so via
`routes.abandoned.target = END`.

### `output` callback

Optional. Called when any child routes `END`, after that child's `assign` has
run (so it sees the up-to-date context). The returned `TPayload` becomes
`event.output.payload` on the parent's `onDone` dispatch.

When `output` is omitted, the compound's `TPayload` defaults to `undefined`
and `routes.*.when(payload)` callbacks see `undefined`.

### Worked example: `socratic`

Before (`examples/zoe/src/states/socratic.ts:14-31` +
`socratic.evaluating.ts:55-67`):

```ts
const socratic = defineCompoundMode<...>({
    initial: "teaching",
    modes: { teaching, listening, evaluating },
    onDone: "classifying",
});

// All three results are encoded inside evaluating's payload and dispatched
// there.
const socraticEvaluating = defineMode<
    ...,
    { result: "achieved" | "retry" | "abandoned" }
>({
    behavior: async (...) => ({ outcome: "achieved", payload: { result } }),
    routes: {
        achieved: [
            { when: (p) => p.result === "achieved",  target: END },
            { when: (p) => p.result === "abandoned", target: END },
            { target: "teaching" },
        ],
        retry: [],
        abandoned: { target: END },
    },
});
```

After:

```ts
const socratic = defineCompoundMode<...>({
    initial: "teaching",
    modes: { teaching, listening, evaluating },
    routes: {
        achieved:  { target: "classifying" },
        retry:     [],
        abandoned: { target: "classifying" },   // could now be a different sibling
    },
});

// Evaluating dispatches between three sibling/exit destinations directly. No
// payload-encoded result; outcome is genuine.
const socraticEvaluating = defineMode<AgentContext, AgentEvents, undefined>({
    behavior: async (...) => {
        const r = await classifyAnswer(...);
        if (r === "achieved")  return { outcome: "achieved",  payload: undefined };
        if (r === "abandoned") return { outcome: "abandoned", payload: undefined };
        return { outcome: "retry", payload: undefined };
    },
    routes: {
        achieved:  { target: END },     // bubbles "achieved" to socratic
        retry:     [],                  // structural self-loop on evaluating
        abandoned: { target: END },     // bubbles "abandoned" to socratic
    },
});
```

The compound now genuinely separates "user understood" from "user gave up",
and either could route to different siblings if a future flow needed it.

## Mapping — Wrapper → XState

Per-outcome final substates replace the single `$end`. Each one declares
XState v5's `output: ({ context }) => ({ outcome, payload })`, which XState
propagates to `event.output` on the parent compound's `onDone` dispatch.
Smoke-tested against `xstate@5.31.1` before spec sign-off — distinct finals'
`output` values reach the parent's guarded `onDone[]` correctly, and `output`
sees context after the entering transition's `assign` has run.

| Wrapper concept                                                       | XState equivalent                                                                 |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `CompoundModeConfig.routes` (the whole map)                           | `onDone: [...]` on the compound state — one ordered entry per `routes[outcome][i]` |
| `routes.achieved[i].target = "sibling"`                               | `onDone[i].guard = e => e.output.outcome === "achieved" && when?(e.output.payload)`; target rewritten |
| `routes.error[i].target = "sibling"`                                  | `onDone[i].guard = e => e.output.outcome === "error" && when?(e.output)` (`when` sees the raw error) |
| `routes[outcome][i].target = END`                                     | Bubbles further: rewrite to the enclosing-compound's matching final substate (chains `END` → `routes` upward) |
| `routes[outcome][i].assign`                                           | `onDone[i].actions = assign(({ context, event }) => f({ context, payload: event.output.payload, deps }))` |
| Per-outcome final substates `$end_achieved` / `$end_abandoned` / `$end_error` | XState `{ type: "final", output: ({ context }) => ({ outcome: "<key>", payload: output?.({ context, deps }) ?? undefined }) }` |
| `CompoundModeConfig.output` (optional)                                | Captured by the per-outcome final substates' `output` callback                    |
| Child's `routes.error.target = END` with compound's `routes.error` omitted | Re-throws above the compound — matches the existing "loud failure" default   |

### Final substate injection — per outcome

For every `CompoundMode` whose subtree references `target: END`, the wrapper
walks the subtree, computes the set of outcome buckets that contained the END
target, and injects one final substate per bucket:

- `$end_achieved` — if any child has `routes.achieved.target = END`
- `$end_abandoned` — if any child has `routes.abandoned.target = END`
- `$end_error` — if any child has `routes.error.target = END`
- `$end_achieved` is also injected if any passive `on[event].target = END` is
  present (passive END defaults to achieved per the table above).

Each `target: END` in a child is rewritten to the matching `$end_<outcome>`
name. Name collision handling reuses today's `pickEndName` strategy
(`packages/atlas/src/injectEnd.ts:48-54`), per-outcome.

### Worked example: lowered output

A compound with
`routes: { achieved: { target: "A" }, retry: [], abandoned: { target: "B" } }`
and two children that both `END` from `routes.achieved` and `routes.abandoned`
lowers to:

```ts
{
    initial: "teaching",
    states: {
        teaching:  { /* onDone[i].target = "$end_achieved" or "$end_abandoned" */ },
        listening: { /* same */ },
        evaluating: { /* same */ },
        $end_achieved:  { type: "final", output: ({ context }) => ({ outcome: "achieved",  payload: undefined }) },
        $end_abandoned: { type: "final", output: ({ context }) => ({ outcome: "abandoned", payload: undefined }) },
    },
    onDone: [
        { guard: ({ event }) => event.output.outcome === "achieved",  target: "A" },
        { guard: ({ event }) => event.output.outcome === "abandoned", target: "B" },
    ],
}
```

When the user declares `output: ({ context }) => ({ count: context.attempts })`,
the final substates' `output` callback is wrapped to compute the payload value
before emitting the `{ outcome, payload }` shape.

## What does NOT change

- **`Mode.routes` shape.** Leaves are unchanged. Only the *meaning* of
  `target: END` is refined: which compound outcome it bubbles is determined by
  the bucket it sits in, which is already a function of the bucket key — no
  new syntax in the leaf.
- **`END` symbol.** Still a unique symbol exported from the wrapper. No
  function form, no parameterization.
- **Compound-local context (`context: { inherit, local }`).** Unrelated;
  unchanged.
- **`Mode.routes.retry` semantics.** Self-loop on the leaf. Compound retry is
  not introduced.
- **`createActor`, the inspector loop, the XState boundary.** The lowered
  XState machine is still a standard `setup().createMachine()`; the inspector
  sees real XState `onDone` arrays.

## Migration

Single PR. Mechanical at every call site that currently uses `onDone`.

1. **`packages/atlas/src/types.ts`** — replace `CompoundModeConfig.onDone:
   RouteTarget` with `routes: CompoundRoutes<...>` and the optional `output?`
   callback; add the `TPayload` generic; add the `CompoundRoutes` alias.
2. **`packages/atlas/src/defineCompoundMode.ts`** — propagate the new
   `TPayload` generic; the carrier shape doesn't change (still opaque).
3. **`packages/atlas/src/compile.ts`** — replace the single `$end` injection
   with per-outcome injection; emit the compound's `onDone[]` array from
   `routes` instead of the single `onDone: { target }` literal; thread
   `output` into each per-outcome final substate's `output` callback.
4. **`packages/atlas/src/injectEnd.ts`** — extend `hasEndReference` to also
   report which outcome bucket(s) the END appears in; extend
   `rewriteEndTargets` to take an outcome→name map and rewrite each entry to
   the matching final substate; add `END_SUBSTATE_FOR(outcome, output?)`
   factory.
5. **`packages/atlas/src/validateRoutes.ts`** + **`validateTargets.ts`** —
   validate the compound's `routes` exactly like a leaf's; reject `retry`
   values other than `readonly []`.
6. **`packages/atlas/test/*`** — every test that constructs a compound with
   `onDone: ...` moves to `routes: { ... }`. Add type-only tests for
   `CompoundRoutes` shape (retry: [] only; output payload typing).
7. **`examples/zoe/src/states/greetings.ts`, `improvising.ts`, `socratic.ts`**
   — replace `onDone: "classifying"` with
   `routes: { achieved: { target: "classifying" }, retry: [], abandoned: { target: "classifying" } }`.
8. **`examples/zoe/src/states/socratic.evaluating.ts`** — drop the
   `payload.result` workaround; behavior returns genuine outcomes; routes use
   `target: END` from each bucket.
9. **Specs 004 and 006** — add a forward-pointer note at the section that
   documents `onDone`; the original prose stays so the history reads
   correctly.

## File Map

| File | Change |
| --- | --- |
| `docs/specs/008-compound-mode-routes.md`             | New spec (this document) |
| `docs/specs/README.md`                               | Add row 008, status Draft |
| `docs/design-decisions.md`                           | New DD recording compound `routes` (symmetric routing surface; per-outcome final injection) and how it supersedes the single `onDone` design |
| `docs/specs/004-xstate-agent-wrapper.md`             | Add a forward-pointer note at `CompoundModeConfig.onDone` referencing spec 008 |
| `docs/specs/006-modes-not-states.md`                 | Same forward-pointer note |
| `packages/atlas/src/types.ts`                        | `CompoundModeConfig.onDone` → `routes` + optional `output`; new `CompoundRoutes` alias |
| `packages/atlas/src/defineCompoundMode.ts`           | Add `TPayload` generic |
| `packages/atlas/src/compile.ts`                      | Per-outcome final substates; compound `onDone[]` array generation |
| `packages/atlas/src/injectEnd.ts`                    | Outcome-aware END detection + rewrite |
| `packages/atlas/src/validateRoutes.ts`               | Compound `routes` validation |
| `packages/atlas/src/validateTargets.ts`              | Reuses leaf logic at the compound level |
| `packages/atlas/test/*`                              | Add compound-routes coverage; migrate existing tests |
| `examples/zoe/src/states/greetings.ts`               | `onDone` → `routes` |
| `examples/zoe/src/states/improvising.ts`             | `onDone` → `routes` |
| `examples/zoe/src/states/socratic.ts`                | `onDone` → `routes` |
| `examples/zoe/src/states/socratic.evaluating.ts`     | Drop `payload.result` workaround |

## Verification

1. **Type-only tests** (`packages/atlas/test/types/*.test-d.ts`):
   - `defineCompoundMode({ routes: { achieved: { target: "x" }, retry: [], abandoned: { target: "y" } } })` compiles.
   - `defineCompoundMode({ onDone: "x" })` is a compile error (no
     struct-typing accidental compatibility).
   - `routes.retry = [{ when: ..., assign: ... }]` is a compile error (only
     `readonly []` is accepted).
   - With `output: ({ context }) => ({ score: number })`,
     `routes.achieved.when` sees `payload: { score: number }`.
   - Without `output`, `routes.achieved.when` sees `payload: undefined`.
2. **Runtime tests**:
   - A compound with two children, each `END`ing from `routes.achieved` and
     `routes.abandoned`, lowers to two distinct final substates. `onDone[]`
     has one entry per outcome bucket the user declared.
   - `output` is invoked after the child's `assign` has run — assert by
     reading `event.output.payload` after a child writes to context and
     `output` reads from it.
   - `output` is NOT invoked on the `retry` path (compound retry never fires
     from a child).
   - A child's `routes.error.target = END` with the compound's `routes.error`
     omitted re-throws above the compound.
   - A child's `routes.error.target = END` with the compound's `routes.error`
     present routes through that bucket; `when` callbacks see the raw error
     from the leaf.
   - Passive `on[event].target = END` lowers to the `$end_achieved` final
     substate.
   - `output` is called with `LocalContextOf<TParent, TCtx>` (the slice view),
     not the parent's full context.
3. **Migration check (examples/zoe)**: all eight conversation scenarios in
   spec 003 §Verification continue to pass with the migrated compounds and
   `socratic.evaluating`.
4. **`compile.ts` diff**: per-outcome `$end_*` injection is the only
   structural addition; the rest is generalizing the existing
   `onDone: { target }` literal to a generated array.

## Out of Scope

- Parameterizing `END` with explicit outcome/payload
  (`END({ outcome, payload })`). Not needed: the bucket determines the
  outcome; `output` produces the payload.
- Compound `retry` semantics (running the compound's children from `initial`
  again as a result of a child's request). `routes.retry: readonly []` is
  shape-only; revisit if a real use case appears.
- Routing on payload predicates *inside* the compound's `routes` is in scope
  by virtue of `output` and the existing `RouteList<E>` shape, but no helper
  is added beyond what `Mode.routes` already exposes.
- `onDone` compatibility shim. Removed cleanly; zoe is the only consumer.
