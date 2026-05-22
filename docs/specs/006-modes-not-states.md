# 006 — Modes, Not States

## Status

Draft. Orthogonal to 005 — both touch `packages/atlas/src/types.ts` but neither depends on the other; either can land first. The single-PR migration is mechanical (rename, no semantic change).

## Goal

Rename the wrapper's user-facing collection of mode slots from `states` to `modes`, aligning the API with the wrapper's own domain vocabulary (DD-002, DD-009) and removing the last piece of XState terminology that leaks into user code.

Concretely:

- `AgentConfig.states` → `AgentConfig.modes`
- `ModeConfig.states` → `ModeConfig.modes`
- `StatesMap<TContext, TEvents>` → `ModesMap<TContext, TEvents>`
- `TStates` generic → `TModes` (on `defineAgent`, `defineMode`, and the type aliases that propagate them)
- `initial: keyof TStates` → `initial: keyof TModes` (mechanically follows the generic rename)

The compiled XState output is **unchanged**: `compile.ts` still emits `setup().createMachine({ id, initial, context, states: { ... } })` because that is XState's own API. Only the wrapper's surface vocabulary changes.

## Problems Addressed

### P7 — `states` is XState terminology leaking through the wrapper

Spec 004 §Verification line 845 ("No XState API leakage in user code") is the wrapper's stated invariant: every name a user writes should belong to the wrapper, not to XState. The current `states:` field violates that. The values are typed as `LeafMode<C, E, P> | Mode<C, E>` (`packages/atlas/src/types.ts:373-376`), constructed via `defineLeafMode` / `defineMode`, and discussed throughout the docs as "the modes the agent has". Calling the field that holds them `states` forces the reader to translate: "states here means the wrapper's modes, which compile to XState states". The field's name should match what the user writes into it.

### P8 — Field name and value type disagree

`StatesMap<TContext, TEvents>` is defined as:

```ts
type StatesMap<TContext, TEvents> = Readonly<Record<
    string,
    LeafMode<TContext, TEvents> | Mode<TContext, TEvents>
>>;
```

The type alias's name is `StatesMap`, but its element type is `LeafMode | Mode`. The whole reason `StatesMap` rejects raw XState configs (spec 004 §`defineMode` line 102: "No raw XState configs. Anything the agent needs is expressible through these two primitives plus `END`") is *because* the wrapper has its own concept — modes — that is the only legitimate way to populate the slot. The naming should reflect that.

### P9 — DD-002 ("each state is a mode") is asymmetric on the surface

DD-002 establishes the mode-as-state equivalence as the wrapper's mental model. The constructors honor it (`defineMode`, `defineLeafMode`). The brands honor it (`Mode`, `LeafMode`). The field that aggregates them does not. After this spec, every user-facing name on the wrapper's surface uses "mode"; "state" survives only at the XState boundary (which the wrapper does not own and explicitly forwards through, per spec 004 line 236: "returns a standard XState `AnyStateMachine`").

## Public API Changes

### `defineAgent`

```ts
export type AgentConfig<
    TContext,
    TEvents extends { type: string },
    TModes extends ModesMap<TContext, TEvents>,
> = {
    id: string;
    initial: keyof TModes & string;
    context: TContext;
    events: TEvents;
    actions?: Readonly<Record<
        string,
        (args: { context: TContext; event: TEvents }) => Partial<TContext>
    >>;
    modes: TModes;
};

export function defineAgent<
    TContext,
    TEvents extends { type: string },
    TModes extends ModesMap<TContext, TEvents>,
>(
    config: AgentConfig<TContext, TEvents, TModes>,
): AnyStateMachine;
```

### `defineMode`

```ts
export type ModeConfig<
    TParentContext,
    TEvents extends { type: string },
    TCtx extends
        | CompoundContext<TParentContext, ReadonlyArray<keyof TParentContext & string>, object>
        | undefined,
    TModes extends ModesMap<LocalContextOf<TParentContext, TCtx>, TEvents>,
> = {
    context?: TCtx;
    initial: keyof TModes & string;
    modes: TModes;
    onDone: RouteTarget;
};

export function defineMode<
    TParentContext,
    TEvents extends { type: string },
    TCtx extends
        | CompoundContext<TParentContext, ReadonlyArray<keyof TParentContext & string>, object>
        | undefined,
    TModes extends ModesMap<LocalContextOf<TParentContext, TCtx>, TEvents>,
>(
    config: ModeConfig<TParentContext, TEvents, TCtx, TModes>,
): Mode<TParentContext, TEvents>;
```

### `ModesMap`

```ts
export type ModesMap<TContext, TEvents extends { type: string }> = Readonly<Record<
    string,
    LeafMode<TContext, TEvents> | Mode<TContext, TEvents>
>>;
```

### `defineLeafMode`

Unchanged. `LeafMode` has no nested mode collection.

### Worked example: Zoe `machine.ts`

Before (`examples/zoe/src/machine.ts:14-38`):

```ts
export const agentMachine = defineAgent<
    AgentContext,
    AgentEvents,
    {
        listening: typeof listening;
        classifying: typeof classifying;
        greetings: typeof greetings;
        socratic: typeof socratic;
        improvising: typeof improvising;
    }
>({
    id: "agent",
    initial: "listening",
    context: { messages: [] },
    events: {} as AgentEvents,
    actions: { /* ... */ },
    states: { listening, classifying, greetings, socratic, improvising },
});
```

After:

```ts
export const agentMachine = defineAgent<
    AgentContext,
    AgentEvents,
    {
        listening: typeof listening;
        classifying: typeof classifying;
        greetings: typeof greetings;
        socratic: typeof socratic;
        improvising: typeof improvising;
    }
>({
    id: "agent",
    initial: "listening",
    context: { messages: [] },
    events: {} as AgentEvents,
    actions: { /* ... */ },
    modes: { listening, classifying, greetings, socratic, improvising },
});
```

A single field rename at every call site.

## Mapping — Wrapper → XState

The compile step continues to emit XState's `states` field unchanged:

| Wrapper concept                         | XState equivalent generated by `compile.ts`        |
| --------------------------------------- | --------------------------------------------------- |
| `AgentConfig.modes`                     | `setup().createMachine({ states: { ... } })`        |
| `ModeConfig.modes` (compound)           | `{ initial, states: { ... }, onDone }`              |
| `AgentConfig.initial` (keyof `TModes`)  | `setup().createMachine({ initial })` — unchanged    |

`compile.ts` reads `config.modes` from the wrapper's input and writes XState's `states` in the output. Snapshot `value` paths (`actor.getSnapshot().value === "socratic.teaching"`) are produced by XState and continue to use XState's path format — the wrapper does not rewrite snapshot output, only input vocabulary.

## What does NOT change

- **The compiled machine.** Every test that introspects `agentMachine.config` or `actor.getSnapshot().value` keeps seeing XState's `states` and XState's path strings. No XState-facing test changes.
- **The `state` word at the XState boundary.** `Snapshot.value`, `XState.AnyStateMachine`, `createActor(machine).start()` — anything that crosses the wrapper-to-XState boundary still uses "state". The wrapper does not pretend it owns the snapshot layer.
- **The `END` symbol and the injected `$end` substate name.** Both internal to compile, unaffected.
- **Compound-local context slots.** The synthetic `__<path>_local` key (`contextLift.ts:42-48`) is unrelated.
- **DD-008 actor naming convention.** Actor names are still derived from the dotted *XState path* (`socraticTeachingNode`), not from a "modes" path — because the actor name is an XState-side artifact.
- **Spec 003 wording.** Spec 003 predates the wrapper and uses "state" in the XState sense throughout; it stays untouched. Future references in new specs use "mode" for wrapper concepts and "state" only when discussing the XState compile output.

## Migration

Single PR, four mechanical layers in order:

1. **`packages/atlas/src/`** — rename `StatesMap` → `ModesMap`, `TStates` → `TModes`, every `states: TStates` field to `modes: TModes`, every `keyof TStates` to `keyof TModes`. In `compile.ts` and `walk.ts`, the *input* read changes from `config.states` to `config.modes`; the *output* emit to XState keeps using the literal `states` key. Update internal JSDoc.
2. **`packages/atlas/test/`** — every test that constructs an agent via `defineAgent({ states: { ... } })` changes to `modes:`. Type-only tests that key off `keyof TStates` change to `TModes`.
3. **`examples/zoe/src/machine.ts`** — single field rename, plus the `typeof`-block already mirrors `TModes` because the type parameter changed.
4. **Spec 004** — the source-of-truth spec. Replace every occurrence of `TStates`, `StatesMap`, and the `states:` field name in code blocks and prose. Mapping table, Type contract, Verification, File Map. Update Status note if needed.
5. **Spec 005** — the agent-deps spec. Same mechanical rename inside the signatures shown on line 14, 75-89, 145-155, and the File Map row.
6. **Docs** — DD recording the rename and its motivation (no XState leakage); architecture diagrams unaffected (they speak in the agent's mode vocabulary already).

## File Map

| File                                                | Change                                                                                |
| --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `docs/specs/006-modes-not-states.md`                | New spec (this document)                                                              |
| `docs/specs/README.md`                              | Add row 006, status Draft                                                              |
| `docs/design-decisions.md`                          | New DD recording the wrapper-vocabulary rename and its tie to spec 004 §Verification 5 |
| `docs/specs/004-xstate-agent-wrapper.md`            | Replace `TStates` → `TModes`, `StatesMap` → `ModesMap`, `states:` → `modes:` throughout |
| `docs/specs/005-agent-deps-and-stringifiable-context.md` | Same rename in signatures, File Map, and prose                                  |
| `packages/atlas/src/types.ts`                       | Rename `StatesMap` → `ModesMap`; rename `TStates` → `TModes` in `AgentConfig`, `ModeConfig`; rename the field `states: TStates` → `modes: TModes`; update JSDoc |
| `packages/atlas/src/defineAgent.ts`                 | Rename `TStates` → `TModes`; update JSDoc                                              |
| `packages/atlas/src/defineMode.ts`                  | Rename `TStates` → `TModes`; update JSDoc                                              |
| `packages/atlas/src/compile.ts`                     | Read `config.modes` instead of `config.states`; keep emitting XState's `states` in the output; rename the local `TStates` generic |
| `packages/atlas/src/walk.ts`                        | If the walker reads `config.states` for compound modes, change to `config.modes`. Compile output unaffected |
| `packages/atlas/test/*.test.ts`                     | Every `defineAgent({ states: ... })` and `defineMode({ states: ... })` → `modes:`     |
| `packages/atlas/test/types/*.test-d.ts`             | Update generic names in `expectTypeOf` cases                                          |
| `examples/zoe/src/machine.ts`                       | `states: { ... }` → `modes: { ... }`                                                  |

No file outside this list is touched. No production behavior changes.

## Verification

1. **Type-only tests** (`packages/atlas/test/types/*.test-d.ts`):
   - A `defineAgent({ modes: { foo: someLeaf } })` with `initial: "foo"` compiles. With `initial: "bar"` (not a key of `modes`) is a compile error.
   - Same for `defineMode`.
   - Constructing with `states:` (the old name) is a compile error: the type system reports "object literal may only specify known properties, did you mean 'modes'?". This proves the rename is exhaustive — no struct-typing accidental compatibility.
   - `ModesMap<TContext, TEvents>` accepts `LeafMode<C, E, P>` and `Mode<C, E>` values; raw XState configs are still rejected.
2. **Runtime tests**:
   - Every existing scenario in `examples/zoe/test/machine.test.ts` passes unchanged in behavior: same conversation flows, same `actor.getSnapshot().value` strings (XState's `states` path format is untouched).
   - `agentMachine.config.states` (XState's introspection) still returns the compiled state map — confirms `compile.ts` emits XState's `states` field unchanged.
   - DD-008 actor names (`classifyingNode`, `socraticTeachingNode`, etc.) are unaffected: snapshot the `setup({ actors })` keys and assert identity with the pre-rename baseline.
3. **Mechanical-rename audit**:
   - `git grep -nE '\bTStates\b|\bStatesMap\b' packages/ examples/ docs/specs/004 docs/specs/005 docs/specs/006` returns zero hits after the migration.
   - `git grep -nE '\bstates:\s' packages/atlas/src/` is allowed only inside `compile.ts` (where the XState emit happens) and inside JSDoc that explicitly references XState terminology — all other matches are a regression.
4. **Architecture diagrams** unchanged. The mermaid sources speak in agent vocabulary (`listening → classifying → greetings`), not in `states:`/`modes:` field names, so the sync hook produces an identical output.

## Out of Scope

- Renaming the XState-facing `Snapshot.value` paths or any compile output that crosses into XState. The wrapper does not own those.
- Renaming `Mode` / `LeafMode` themselves. The brand types and the constructors already use the right vocabulary.
- Renaming `state.value` in code that uses `actor.getSnapshot().value` — that is XState's API, not the wrapper's.
- Renaming `TParentContext` / `TCtx` to a uniform `TLocalContext` family. Defensible but cosmetic and independent — earns its own spec if pursued.
- Renaming `TStates`-adjacent identifiers in spec 003 prose. Spec 003 predates the wrapper and discusses states in the XState sense; rewriting it is out of scope here.
- Touching the inspector loop in `examples/zoe/src/machine.ts:52-71` — it consumes XState snapshots, where "state" is the right word.
