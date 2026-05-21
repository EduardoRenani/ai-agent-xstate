// Phase 5.11 helpers: `$end` substate injection + END-target rewrite.
//
// Spec: docs/specs/004-tasks.md Phase 5.11 + 5.12,
// docs/specs/004-xstate-agent-wrapper.md §"END and the injected final substate"
// (lines 631-635).
//
// A compound mode whose subtree references `target: END` anywhere needs an
// injected final substate to exit through — XState requires a concrete state
// name as a transition target, the spec keeps `END` as a symbol so it cannot
// collide with user-declared names. This module provides the building blocks:
//   - `pickEndName(siblings)`: collision-safe name (`$end`, `$end1`, ...)
//   - `hasEndReference(state)`: does a lowered leaf state mention END anywhere?
//   - `rewriteEndTargets(state, name)`: same shape with every END target swapped
//   - `END_SUBSTATE`: the XState final-substate config to inject
//
// The compound-lowering slice (5.16) composes these:
//   if any direct child references END → pickEndName(Object.keys(states)),
//     rewriteEndTargets on each child, set states[endName] = END_SUBSTATE.
//   Otherwise leave the compound open (5.12 — no final substate emitted).

import { END } from "./types.ts";
import type { LoweredAtomicState, LoweredTransition } from "./buildPassiveState.ts";
import type {
    LoweredInvokeState,
    LoweredOnDoneTransition,
    LoweredOnErrorTransition,
} from "./buildActiveState.ts";

export type LoweredLeafState = LoweredAtomicState | LoweredInvokeState;

// XState final-substate config — what gets dropped into `states[endName]`.
export const END_SUBSTATE = { type: "final" as const };

// `Array.isArray` widens `readonly T[]` to `any[]` and fails to subtract it
// from a `T | readonly T[]` union. Typed predicate keeps narrowing precise
// without leaking `any`. (Same pattern as buildPassiveState / buildActiveState.)
function isReadonlyArray<T>(value: T | readonly T[]): value is readonly T[] {
    return Array.isArray(value);
}

function isInvoke(state: LoweredLeafState): state is LoweredInvokeState {
    return "invoke" in state;
}

// `$end` if available, then `$end1`, `$end2`, ... — the `$` prefix is unusual
// enough that collisions with user keys are vanishingly rare, but we still
// probe and bump for safety.
export function pickEndName(siblings: readonly string[]): string {
    const set = new Set(siblings);
    if (!set.has("$end")) return "$end";
    let i = 1;
    while (set.has(`$end${i}`)) i += 1;
    return `$end${i}`;
}

export function hasEndReference(state: LoweredLeafState): boolean {
    if (isInvoke(state)) {
        for (const t of state.invoke.onDone) {
            if (t.target === END) return true;
        }
        if (state.invoke.onError !== undefined) {
            for (const t of state.invoke.onError) {
                if (t.target === END) return true;
            }
        }
        return false;
    }
    for (const transitions of Object.values(state.on)) {
        const list = isReadonlyArray(transitions) ? transitions : [transitions];
        for (const t of list) {
            if (t.target === END) return true;
        }
    }
    return false;
}

function rewritePassiveTransition(
    t: LoweredTransition,
    endName: string,
): LoweredTransition {
    if (t.target !== END) return t;
    return { ...t, target: endName };
}

function rewriteOnDoneTransition(
    t: LoweredOnDoneTransition,
    endName: string,
): LoweredOnDoneTransition {
    if (t.target !== END) return t;
    return { ...t, target: endName };
}

function rewriteOnErrorTransition(
    t: LoweredOnErrorTransition,
    endName: string,
): LoweredOnErrorTransition {
    if (t.target !== END) return t;
    return { ...t, target: endName };
}

// Returns a new lowered state with every `target === END` rewritten to
// `endName`. Non-END targets, `actions`, `guard`, and `reenter` flags are
// preserved by reference. The input is not mutated.
export function rewriteEndTargets(
    state: LoweredLeafState,
    endName: string,
): LoweredLeafState {
    if (isInvoke(state)) {
        const onDone = state.invoke.onDone.map((t) =>
            rewriteOnDoneTransition(t, endName),
        );
        const invoke: LoweredInvokeState["invoke"] = {
            src: state.invoke.src,
            input: state.invoke.input,
            onDone,
        };
        if (state.invoke.onError !== undefined) {
            invoke.onError = state.invoke.onError.map((t) =>
                rewriteOnErrorTransition(t, endName),
            );
        }
        return { invoke };
    }
    const on: LoweredAtomicState["on"] = {};
    for (const [event, transitions] of Object.entries(state.on)) {
        on[event] = isReadonlyArray(transitions)
            ? transitions.map((t) => rewritePassiveTransition(t, endName))
            : rewritePassiveTransition(transitions, endName);
    }
    return { on };
}
