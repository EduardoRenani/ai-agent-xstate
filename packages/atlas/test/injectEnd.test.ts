// Phase 5.11 runtime tests: `$end` substate name picking, END-target
// detection, and END-target rewrite. Spec: docs/specs/004-tasks.md Phase 5.11.

import { describe, expect, test } from "vitest";

import {
    END_SUBSTATE,
    hasEndReference,
    pickEndName,
    rewriteEndTargets,
} from "../src/injectEnd.ts";
import { END } from "../src/types.ts";
import type { LoweredAtomicState } from "../src/buildPassiveState.ts";
import type { LoweredInvokeState } from "../src/buildActiveState.ts";

describe("pickEndName()", () => {
    test("returns `$end` when sibling list is empty", () => {
        expect(pickEndName([])).toBe("$end");
    });

    test("returns `$end` when no sibling collides", () => {
        expect(pickEndName(["foo", "bar"])).toBe("$end");
    });

    test("returns `$end1` when `$end` is taken", () => {
        expect(pickEndName(["$end"])).toBe("$end1");
    });

    test("returns `$end2` when both `$end` and `$end1` are taken", () => {
        expect(pickEndName(["$end", "$end1"])).toBe("$end2");
    });

    test("skips correctly when only `$end1` is taken (still picks `$end`)", () => {
        expect(pickEndName(["$end1"])).toBe("$end");
    });
});

describe("hasEndReference()", () => {
    test("passive state with END in scalar transition → true", () => {
        const state: LoweredAtomicState = {
            on: { CLICK: { target: END } },
        };
        expect(hasEndReference(state)).toBe(true);
    });

    test("passive state with END inside array-form transitions → true", () => {
        const state: LoweredAtomicState = {
            on: {
                CLICK: [{ target: "next" }, { target: END }],
            },
        };
        expect(hasEndReference(state)).toBe(true);
    });

    test("passive state without END → false", () => {
        const state: LoweredAtomicState = {
            on: { CLICK: { target: "next" } },
        };
        expect(hasEndReference(state)).toBe(false);
    });

    test("active state with onDone[i].target === END → true", () => {
        const state: LoweredInvokeState = {
            invoke: {
                src: "fooNode",
                input: () => undefined,
                onDone: [{ target: END }],
            },
        };
        expect(hasEndReference(state)).toBe(true);
    });

    test("active state with onError[i].target === END → true", () => {
        const state: LoweredInvokeState = {
            invoke: {
                src: "fooNode",
                input: () => undefined,
                onDone: [{ target: "next" }],
                onError: [{ target: END }],
            },
        };
        expect(hasEndReference(state)).toBe(true);
    });

    test("active state with no END references → false", () => {
        const state: LoweredInvokeState = {
            invoke: {
                src: "fooNode",
                input: () => undefined,
                onDone: [{ target: "next" }],
                onError: [{ target: "errState" }],
            },
        };
        expect(hasEndReference(state)).toBe(false);
    });

    test("active state without `onError` (RE_THROW-less leaf) → false on END check alone", () => {
        const state: LoweredInvokeState = {
            invoke: {
                src: "fooNode",
                input: () => undefined,
                onDone: [{ target: "next" }],
            },
        };
        expect(hasEndReference(state)).toBe(false);
    });
});

describe("rewriteEndTargets()", () => {
    test("rewrites passive END target to endName (scalar form)", () => {
        const state: LoweredAtomicState = {
            on: { CLICK: { target: END } },
        };
        expect(rewriteEndTargets(state, "$end")).toEqual({
            on: { CLICK: { target: "$end" } },
        });
    });

    test("rewrites passive END targets inside array form", () => {
        const state: LoweredAtomicState = {
            on: {
                CLICK: [{ target: "next" }, { target: END }],
            },
        };
        expect(rewriteEndTargets(state, "$end")).toEqual({
            on: {
                CLICK: [{ target: "next" }, { target: "$end" }],
            },
        });
    });

    test("rewrites active onDone ENDs and leaves other targets verbatim", () => {
        const state: LoweredInvokeState = {
            invoke: {
                src: "fooNode",
                input: () => undefined,
                onDone: [{ target: END }, { target: "retry" }],
            },
        };
        const out = rewriteEndTargets(state, "$end") as LoweredInvokeState;
        expect(out.invoke.onDone).toEqual([
            { target: "$end" },
            { target: "retry" },
        ]);
    });

    test("rewrites active onError ENDs and leaves other targets verbatim", () => {
        const state: LoweredInvokeState = {
            invoke: {
                src: "fooNode",
                input: () => undefined,
                onDone: [{ target: "next" }],
                onError: [{ target: END }, { target: "errState" }],
            },
        };
        const out = rewriteEndTargets(state, "$end") as LoweredInvokeState;
        expect(out.invoke.onError).toEqual([
            { target: "$end" },
            { target: "errState" },
        ]);
    });

    test("preserves guard / actions / reenter on rewritten transitions", () => {
        const guard = () => true;
        const state: LoweredInvokeState = {
            invoke: {
                src: "fooNode",
                input: () => undefined,
                onDone: [{ guard, target: END, reenter: true }],
            },
        };
        const out = rewriteEndTargets(state, "$end") as LoweredInvokeState;
        expect(out.invoke.onDone).toEqual([
            { guard, target: "$end", reenter: true },
        ]);
    });

    test("does not mutate the input state", () => {
        const state: LoweredAtomicState = {
            on: { CLICK: { target: END } },
        };
        rewriteEndTargets(state, "$end");
        expect(state.on.CLICK).toEqual({ target: END });
    });

    test("custom endName (collision case) is honored", () => {
        const state: LoweredAtomicState = {
            on: { CLICK: { target: END } },
        };
        expect(rewriteEndTargets(state, "$end2")).toEqual({
            on: { CLICK: { target: "$end2" } },
        });
    });
});

describe("END_SUBSTATE", () => {
    test("is the XState final-substate config `{ type: 'final' }`", () => {
        expect(END_SUBSTATE).toEqual({ type: "final" });
    });
});
