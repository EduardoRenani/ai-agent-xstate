// Compound-local context lift — the read-view + slot-lifecycle primitives.
//
// Spec: docs/specs/004-xstate-agent-wrapper.md §"Lexical scoping of context"
//       + docs/specs/012-xstate-containment.md §Seam 3 (DD-033).
//
// A `CompoundMode` with `context: { inherit, local }` exposes a narrowed view
// to its children: `Pick<TParent, inherit[number]> & typeof local`. At runtime
// the lift materializes this view by allocating a slot under a generated
// root-context key (`__<path>_local`), initialized to `local` on every entry
// and cleared on every exit.
//
// Inherit keys are read live from the parent (no copy on entry, no project-back
// on exit). Local keys live in this compound's own slot and reset automatically
// on re-entry. Nested compounds chain: a nested `LiftContext` carries a `parent`
// reference that `buildSubContext` walks to resolve inherit reads.
//
// SPEC 012 §Seam 3: this module exposes only the engine-neutral lift primitives
// — `compoundLocalKey`, `buildSubContext` (read-view), and the slot
// `makeCompoundEntry` / `makeCompoundExit` actions. `xstateBackend`'s IR
// translator owns the write-split (`splitUserUpdate`) and the patch/guard
// adaptation; the per-callback `lift*` wrappers and the split helper that used
// to live here were removed when the lowering moved to the IR.

import { wrapAssign, type AssignAction } from "./xstateBackend.ts";

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
export function buildSubContext(
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

// XState `entry` action: initialize this compound's local slot. A fresh
// shallow copy of `initialLocal` per entry so subsequent mutations stay
// scoped to this activation. Deep cloning is not promised — the spec's
// canonical local is primitive-valued (`{ attempts: 0 }`); nested object
// values are shared by reference.
export function makeCompoundEntry(lift: LiftContext): AssignAction {
    return wrapAssign({
        [lift.key]: () => ({ ...lift.initialLocal }),
    });
}

// XState `exit` action: clear this compound's local slot. The next entry
// (if any) re-initializes via `makeCompoundEntry`, satisfying the
// reset-on-re-entry invariant from spec line 109.
export function makeCompoundExit(lift: LiftContext): AssignAction {
    return wrapAssign({
        [lift.key]: () => undefined,
    });
}
