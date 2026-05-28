// Runtime tests for `injectEnd.ts` — spec 008 per-outcome `$end_*` injection,
// bucket sentinel collection, bucket-aware target rewriting, and the
// `rewriteErrorBucketToReThrow` path used when an enclosing compound omits
// `routes.error`.

import { describe, expect, test } from "vitest";

import {
    END_ABANDONED,
    END_ACHIEVED,
    END_ERROR,
} from "../src/endBuckets.ts";
import {
    collectEndBuckets,
    makeFinalSubstate,
    pickEndName,
    rewriteEndTargets,
    rewriteErrorBucketToReThrow,
} from "../src/injectEnd.ts";
import type { LoweredAtomicState } from "../src/buildPassiveState.ts";
import type {
    LoweredInvokeState,
    LoweredOnDoneTransition,
    LoweredOnErrorTransition,
} from "../src/buildActiveState.ts";

const noDeps = Object.freeze({});

describe("pickEndName()", () => {
    test("returns `$end_achieved` when sibling list is empty", () => {
        expect(pickEndName("achieved", [])).toBe("$end_achieved");
    });

    test("returns `$end_<outcome>` when no sibling collides", () => {
        expect(pickEndName("abandoned", ["foo", "bar"])).toBe("$end_abandoned");
        expect(pickEndName("error", ["foo", "bar"])).toBe("$end_error");
    });

    test("bumps numeric suffix when base name collides", () => {
        expect(pickEndName("achieved", ["$end_achieved"])).toBe("$end_achieved1");
        expect(pickEndName("achieved", ["$end_achieved", "$end_achieved1"])).toBe(
            "$end_achieved2",
        );
    });

    test("each outcome gets its own namespace (no cross-bucket collision)", () => {
        // `$end_achieved` taken does not affect `$end_abandoned`.
        expect(pickEndName("abandoned", ["$end_achieved"])).toBe("$end_abandoned");
    });
});

describe("collectEndBuckets()", () => {
    test("passive state with achieved sentinel in scalar transition", () => {
        const state: LoweredAtomicState = {
            on: { CLICK: { target: END_ACHIEVED } },
        };
        const buckets = collectEndBuckets(state);
        expect(buckets.has(END_ACHIEVED)).toBe(true);
        expect(buckets.size).toBe(1);
    });

    test("passive state with achieved sentinel inside array form", () => {
        const state: LoweredAtomicState = {
            on: {
                CLICK: [{ target: "next" }, { target: END_ACHIEVED }],
            },
        };
        expect(collectEndBuckets(state).has(END_ACHIEVED)).toBe(true);
    });

    test("passive state without any sentinel → empty set", () => {
        const state: LoweredAtomicState = {
            on: { CLICK: { target: "next" } },
        };
        expect(collectEndBuckets(state).size).toBe(0);
    });

    test("active state with onDone bucket sentinels reports them all", () => {
        const state: LoweredInvokeState = {
            invoke: {
                src: "fooNode",
                input: () => undefined,
                onDone: [
                    { target: END_ACHIEVED },
                    { target: "self", reenter: true },
                    { target: END_ABANDONED },
                ],
            },
        };
        const buckets = collectEndBuckets(state);
        expect(buckets.has(END_ACHIEVED)).toBe(true);
        expect(buckets.has(END_ABANDONED)).toBe(true);
        expect(buckets.has(END_ERROR)).toBe(false);
    });

    test("active state with onError bucket sentinel → reports error", () => {
        const state: LoweredInvokeState = {
            invoke: {
                src: "fooNode",
                input: () => undefined,
                onDone: [{ target: "next" }],
                onError: [{ target: END_ERROR }],
            },
        };
        expect(collectEndBuckets(state).has(END_ERROR)).toBe(true);
    });

    test("active state with no sentinel references → empty set", () => {
        const state: LoweredInvokeState = {
            invoke: {
                src: "fooNode",
                input: () => undefined,
                onDone: [{ target: "next" }],
                onError: [{ target: "errState" }],
            },
        };
        expect(collectEndBuckets(state).size).toBe(0);
    });
});

describe("rewriteEndTargets()", () => {
    test("rewrites passive achieved sentinel to mapped name", () => {
        const map = new Map([[END_ACHIEVED, "$end_achieved"] as const]);
        const state: LoweredAtomicState = {
            on: { CLICK: { target: END_ACHIEVED } },
        };
        expect(rewriteEndTargets(state, map)).toEqual({
            on: { CLICK: { target: "$end_achieved" } },
        });
    });

    test("rewrites array-form passive sentinels", () => {
        const map = new Map([[END_ACHIEVED, "$end_achieved"] as const]);
        const state: LoweredAtomicState = {
            on: {
                CLICK: [{ target: "next" }, { target: END_ACHIEVED }],
            },
        };
        expect(rewriteEndTargets(state, map)).toEqual({
            on: {
                CLICK: [{ target: "next" }, { target: "$end_achieved" }],
            },
        });
    });

    test("rewrites onDone bucket sentinels per the map; leaves others verbatim", () => {
        const map = new Map([
            [END_ACHIEVED, "$end_achieved"],
            [END_ABANDONED, "$end_abandoned"],
        ] as const);
        const state: LoweredInvokeState = {
            invoke: {
                src: "fooNode",
                input: () => undefined,
                onDone: [
                    { target: END_ACHIEVED },
                    { target: "self", reenter: true },
                    { target: END_ABANDONED },
                ],
            },
        };
        const out = rewriteEndTargets(state, map) as LoweredInvokeState;
        expect(out.invoke.onDone).toEqual([
            { target: "$end_achieved" },
            { target: "self", reenter: true },
            { target: "$end_abandoned" },
        ]);
    });

    test("rewrites onError ENDs and leaves other targets verbatim", () => {
        const map = new Map([[END_ERROR, "$end_error"] as const]);
        const state: LoweredInvokeState = {
            invoke: {
                src: "fooNode",
                input: () => undefined,
                onDone: [{ target: "next" }],
                onError: [{ target: END_ERROR }, { target: "errState" }],
            },
        };
        const out = rewriteEndTargets(state, map) as LoweredInvokeState;
        expect(out.invoke.onError).toEqual([
            { target: "$end_error" },
            { target: "errState" },
        ]);
    });

    test("preserves guard / actions / reenter on rewritten transitions", () => {
        const guard = (): boolean => true;
        const map = new Map([[END_ACHIEVED, "$end_achieved"] as const]);
        const state: LoweredInvokeState = {
            invoke: {
                src: "fooNode",
                input: () => undefined,
                onDone: [{ guard, target: END_ACHIEVED, reenter: true }],
            },
        };
        const out = rewriteEndTargets(state, map) as LoweredInvokeState;
        expect(out.invoke.onDone).toEqual([
            { guard, target: "$end_achieved", reenter: true },
        ]);
    });

    test("does not mutate the input state", () => {
        const map = new Map([[END_ACHIEVED, "$end_achieved"] as const]);
        const state: LoweredAtomicState = {
            on: { CLICK: { target: END_ACHIEVED } },
        };
        rewriteEndTargets(state, map);
        expect(state.on.CLICK).toEqual({ target: END_ACHIEVED });
    });

    test("collision-mapped names are honored", () => {
        const map = new Map([[END_ACHIEVED, "$end_achieved2"] as const]);
        const state: LoweredAtomicState = {
            on: { CLICK: { target: END_ACHIEVED } },
        };
        expect(rewriteEndTargets(state, map)).toEqual({
            on: { CLICK: { target: "$end_achieved2" } },
        });
    });
});

describe("makeFinalSubstate()", () => {
    test("achieved final: payload defaults to `undefined` without outputCb", () => {
        const final = makeFinalSubstate("achieved", undefined, undefined, noDeps);
        expect(final.type).toBe("final");
        expect(final.output({ context: { foo: 1 }, event: {} })).toEqual({
            outcome: "achieved",
            payload: undefined,
        });
    });

    test("achieved final: payload comes from outputCb when supplied", () => {
        const outputCb = ({ context }: { context: unknown }): unknown => {
            const c = context as { count: number };
            return { count: c.count * 2 };
        };
        const final = makeFinalSubstate("achieved", outputCb, undefined, noDeps);
        expect(final.output({ context: { count: 3 }, event: {} })).toEqual({
            outcome: "achieved",
            payload: { count: 6 },
        });
    });

    test("abandoned final: outcome label flips, same outputCb mechanics", () => {
        const final = makeFinalSubstate("abandoned", undefined, undefined, noDeps);
        expect(final.output({ context: {}, event: {} })).toEqual({
            outcome: "abandoned",
            payload: undefined,
        });
    });

    test("error final: payload is the raw `event.error`; outputCb is ignored", () => {
        const outputCb = (): unknown => "ignored";
        const final = makeFinalSubstate("error", outputCb, undefined, noDeps);
        const boom = new Error("boom");
        expect(final.output({ context: {}, event: { error: boom } })).toEqual({
            outcome: "error",
            payload: boom,
        });
    });
});

describe("rewriteErrorBucketToReThrow()", () => {
    test("converts onError END_ERROR entry into a target-less throw action", () => {
        const state: LoweredInvokeState = {
            invoke: {
                src: "fooNode",
                input: () => undefined,
                onDone: [{ target: "next" }],
                onError: [{ target: END_ERROR }],
            },
        };
        const out = rewriteErrorBucketToReThrow(state) as LoweredInvokeState;
        expect(out.invoke.onError).toBeDefined();
        const onError = out.invoke.onError as readonly LoweredOnErrorTransition[];
        expect(onError.length).toBe(1);
        expect(onError[0].target).toBeUndefined();
        expect(typeof onError[0].actions).toBe("function");
        // The action throws when invoked with an error event.
        const action = onError[0].actions as (args: { event: { error: unknown } }) => never;
        expect(() => action({ event: { error: new Error("boom") } })).toThrow("boom");
    });

    test("preserves guard from the rewritten entry", () => {
        const guard = (): boolean => true;
        const state: LoweredInvokeState = {
            invoke: {
                src: "fooNode",
                input: () => undefined,
                onDone: [{ target: "next" }],
                onError: [{ guard, target: END_ERROR }],
            },
        };
        const out = rewriteErrorBucketToReThrow(state) as LoweredInvokeState;
        const onError = out.invoke.onError as readonly LoweredOnErrorTransition[];
        expect(onError[0].guard).toBe(guard);
    });

    test("leaves non-sentinel onError entries verbatim", () => {
        const state: LoweredInvokeState = {
            invoke: {
                src: "fooNode",
                input: () => undefined,
                onDone: [{ target: "next" }],
                onError: [{ target: "errState" }],
            },
        };
        const out = rewriteErrorBucketToReThrow(state) as LoweredInvokeState;
        expect(out.invoke.onError).toEqual([{ target: "errState" }]);
    });

    test("no-op on passive leaves and on leaves without onError", () => {
        const passive: LoweredAtomicState = {
            on: { CLICK: { target: "next" } },
        };
        expect(rewriteErrorBucketToReThrow(passive)).toBe(passive);

        const active: LoweredInvokeState = {
            invoke: {
                src: "fooNode",
                input: () => undefined,
                onDone: [{ target: "next" }],
            },
        };
        expect(rewriteErrorBucketToReThrow(active)).toBe(active);
    });
});

// Sanity smoke: `LoweredOnDoneTransition` widening accepts the sentinel
// without `as` casts. If this compiles, the public type surface is correct.
function _typeSmoke(): void {
    const t: LoweredOnDoneTransition = { target: END_ACHIEVED };
    void t;
}
