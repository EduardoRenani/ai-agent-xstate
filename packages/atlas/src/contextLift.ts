// Phase 5.13 helpers: compound-local context lift.
//
// Spec: docs/specs/004-tasks.md Phase 5.13,
// docs/specs/004-xstate-agent-wrapper.md §"Lexical scoping of context"
// (lines 104-111) and §Mapping line 626.
//
// A `Mode` with `context: { inherit, local }` exposes a narrowed view to its
// children: `Pick<TParent, inherit[number]> & typeof local`. At runtime the
// wrapper materializes this view by:
//   - allocating a slot under a generated root-context key (`__<path>_local`)
//     initialized to `local` on every entry, cleared on every exit
//   - wrapping each child callback (`input`, `assign`, passive `guard`) so
//     the `context` they see is the virtual merged view, and any `Partial`
//     they return is split back to the correct destination
//
// Inherit keys are read live from the parent (no copy on entry, no
// project-back on exit) — writes propagate through to the owning slot in
// the same step. Local keys live in this compound's own slot and reset
// automatically on re-entry. Nested compounds chain: a nested `LiftContext`
// carries a `parent` reference that the helpers walk to resolve inherit
// reads/writes.
//
// The actual emission of `entry`/`exit` actions onto a lowered compound
// shape, plus the threading of `LiftContext` through the walk, lands in
// slice 5.16; 5.13 ships the toolkit and integrates it with
// `buildActiveState` / `buildPassiveState` via an optional `lift` argument.

import { assign } from "xstate";

export type LiftContext = {
    readonly key: string;                                       // own slot, e.g. "__socratic_local"
    readonly inherit: readonly string[];                        // keys visible from parent view
    readonly initialLocal: Readonly<Record<string, unknown>>;   // declared `local` shape
    readonly parent?: LiftContext;                              // enclosing compound, if any
};

// Slot-name generator. Path is the compound's dotted slot
// (e.g. `socratic.evaluating` → `__socratic_evaluating_local`). The `__`
// prefix + `_local` suffix make collisions with user-declared agent-context
// keys vanishingly rare; dots are replaced with `_` so the key is a valid
// JS identifier.
export function compoundLocalKey(path: string): string {
    if (path === "") {
        throw new Error("atlas/contextLift: compoundLocalKey called with empty path");
    }
    const safe = path.replace(/\./g, "_");
    return `__${safe}_local`;
}

function localKeys(lift: LiftContext): readonly string[] {
    return Object.keys(lift.initialLocal);
}

// Build the parent's effective view from the root context. For a top-level
// compound (no parent), the parent view IS the root context. For a nested
// compound, recurse into the enclosing lift to materialize ITS subContext.
function buildParentView(
    rootContext: Record<string, unknown>,
    parent: LiftContext | undefined,
): Record<string, unknown> {
    if (parent === undefined) return rootContext;
    return buildSubContext(rootContext, parent);
}

// Build the virtual subContext a child callback sees: inherit keys read
// from the parent view (live), local keys read from this compound's slot.
function buildSubContext(
    rootContext: Record<string, unknown>,
    lift: LiftContext,
): Record<string, unknown> {
    const parentView = buildParentView(rootContext, lift.parent);
    const sub: Record<string, unknown> = {};
    for (const k of lift.inherit) {
        sub[k] = parentView[k];
    }
    const slot = rootContext[lift.key];
    if (slot !== undefined && typeof slot === "object" && slot !== null) {
        const slotRec = slot as Record<string, unknown>;
        for (const k of localKeys(lift)) {
            sub[k] = slotRec[k];
        }
    }
    return sub;
}

// Walk up the parent chain to find which ancestor declared `key` as a
// local. If no ancestor owns it, the key lives in the agent's root context.
function findInheritOwner(
    key: string,
    parent: LiftContext | undefined,
): { kind: "root" } | { kind: "slot"; slotKey: string } {
    if (parent === undefined) return { kind: "root" };
    if (localKeys(parent).includes(key)) return { kind: "slot", slotKey: parent.key };
    return findInheritOwner(key, parent.parent);
}

// Split the user's `Partial<combined>` return into a root-context patch
// XState's `assign` can apply. Local writes update this compound's slot;
// inherit writes update either the agent root or an ancestor's slot,
// depending on where the key was declared as local.
function splitUserUpdate(
    update: Record<string, unknown>,
    rootContext: Record<string, unknown>,
    lift: LiftContext,
): Record<string, unknown> {
    const ownLocals = localKeys(lift);
    const rootPatch: Record<string, unknown> = {};
    const slotPatches: Record<string, Record<string, unknown>> = {};

    function touchSlot(slotKey: string, k: string, v: unknown): void {
        const existing = slotPatches[slotKey] ?? {};
        existing[k] = v;
        slotPatches[slotKey] = existing;
    }

    for (const [k, v] of Object.entries(update)) {
        if (ownLocals.includes(k)) {
            touchSlot(lift.key, k, v);
            continue;
        }
        if (lift.inherit.includes(k)) {
            const owner = findInheritOwner(k, lift.parent);
            if (owner.kind === "root") {
                rootPatch[k] = v;
            } else {
                touchSlot(owner.slotKey, k, v);
            }
            continue;
        }
        // Out-of-scope key: the type system already rejected it. A bypass
        // via `as` reaches here — drop silently rather than leak into root.
    }

    // XState `assign` is shallow at the root level — we must hand it the
    // full new slot object, not a delta.
    for (const [slotKey, patch] of Object.entries(slotPatches)) {
        const current = (rootContext[slotKey] ?? {}) as Record<string, unknown>;
        rootPatch[slotKey] = { ...current, ...patch };
    }

    return rootPatch;
}

// Wrap a user `input({ context, deps })` callback so it sees the virtual
// view. `deps` is captured verbatim from the closure that `compile.ts`
// threaded down — the lift only transforms `context`.
export function liftInput(
    userInput: (args: { context: unknown; deps: Readonly<Record<string, unknown>> }) => unknown,
    lift: LiftContext,
    deps: Readonly<Record<string, unknown>>,
): (args: { context: unknown }) => unknown {
    return ({ context }) => {
        const sub = buildSubContext(context as Record<string, unknown>, lift);
        return userInput({ context: sub, deps });
    };
}

// Wrap a user `assign({ context, payload, deps }) => Partial<combined>`
// callback, returning an XState `assign(...)` action that applies the split
// update. `deps` is forwarded by identity from the wrapper's closure.
export function liftExitAssign(
    userAssign: (args: { context: unknown; payload: unknown; deps: Readonly<Record<string, unknown>> }) => object,
    lift: LiftContext,
    deps: Readonly<Record<string, unknown>>,
): ReturnType<typeof assign> {
    return assign(({ context, event }) => {
        const root = context as Record<string, unknown>;
        const sub = buildSubContext(root, lift);
        const payload = (event as unknown as { output: { payload: unknown } }).output.payload;
        const update = userAssign({ context: sub, payload, deps }) as Record<string, unknown>;
        return splitUserUpdate(update, root, lift);
    });
}

// Wrap a user `assign({ context, error, deps })` callback (error routes).
export function liftErrorAssign(
    userAssign: (args: { context: unknown; error: unknown; deps: Readonly<Record<string, unknown>> }) => object,
    lift: LiftContext,
    deps: Readonly<Record<string, unknown>>,
): ReturnType<typeof assign> {
    return assign(({ context, event }) => {
        const root = context as Record<string, unknown>;
        const sub = buildSubContext(root, lift);
        const error = (event as unknown as { error: unknown }).error;
        const update = userAssign({ context: sub, error, deps }) as Record<string, unknown>;
        return splitUserUpdate(update, root, lift);
    });
}

// Wrap a user `guard({ context, event, deps })` (passive `on` transitions).
export function liftGuard(
    userGuard: (args: { context: unknown; event: unknown; deps: Readonly<Record<string, unknown>> }) => boolean,
    lift: LiftContext,
    deps: Readonly<Record<string, unknown>>,
): (args: { context: unknown; event: unknown }) => boolean {
    return ({ context, event }) => {
        const sub = buildSubContext(context as Record<string, unknown>, lift);
        return userGuard({ context: sub, event, deps });
    };
}

// XState `entry` action: initialize this compound's local slot. A fresh
// shallow copy of `initialLocal` per entry so subsequent mutations stay
// scoped to this activation. Deep cloning is not promised — the spec's
// canonical local is primitive-valued (`{ attempts: 0 }`); nested object
// values are shared by reference.
export function makeCompoundEntry(lift: LiftContext): ReturnType<typeof assign> {
    return assign({
        [lift.key]: () => ({ ...lift.initialLocal }),
    });
}

// XState `exit` action: clear this compound's local slot. The next entry
// (if any) re-initializes via `makeCompoundEntry`, satisfying the
// reset-on-re-entry invariant from spec line 109.
export function makeCompoundExit(lift: LiftContext): ReturnType<typeof assign> {
    return assign({
        [lift.key]: () => undefined,
    });
}
