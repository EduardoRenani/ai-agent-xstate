// Spec 008 type-only tests — `CompoundMode.routes` + optional `output?`.
// Covers spec 008 §Verification.1.

import { describe, expectTypeOf, test } from "vitest";

import { defineCompoundMode } from "../../src/defineCompoundMode.ts";
import { defineMode } from "../../src/defineMode.ts";
import { END } from "../../src/types.ts";

type Ctx = { messages: readonly string[]; turns: number };
type Events = { type: "GO" };

// Two minimal children so `modes` typechecks under both with-output and
// without-output compound shapes. They have no `target: END` reach beyond
// what each test needs.
const childA = defineMode<Ctx, Events>({ on: {} });
const childB = defineMode<Ctx, Events>({ on: {} });

describe("CompoundMode.routes — accepted shape", () => {
    test("`{ achieved, retry: [], abandoned }` typechecks", () => {
        const group = defineCompoundMode<
            Ctx,
            Events,
            undefined,
            { childA: typeof childA; childB: typeof childB }
        >({
            initial: "childA",
            modes: { childA, childB },
            routes: {
                achieved: { target: "childB" },
                retry: [],
                abandoned: { target: "childA" },
            },
        });
        // Brand only — no public surface to assert on, just that the call
        // typechecks at all.
        expectTypeOf(group).not.toBeNever();
    });

    test("`{ achieved, retry: [], abandoned, error }` typechecks", () => {
        const group = defineCompoundMode<
            Ctx,
            Events,
            undefined,
            { childA: typeof childA; childB: typeof childB }
        >({
            initial: "childA",
            modes: { childA, childB },
            routes: {
                achieved: { target: "childB" },
                retry: [],
                abandoned: { target: "childA" },
                error: { target: "childA" },
            },
        });
        expectTypeOf(group).not.toBeNever();
    });
});

describe("CompoundMode.routes — rejected shapes (compile errors)", () => {
    test("legacy `onDone: \"x\"` is no longer accepted (no struct-typing compatibility)", () => {
        defineCompoundMode<
            Ctx,
            Events,
            undefined,
            { childA: typeof childA }
        >({
            initial: "childA",
            modes: { childA },
            // @ts-expect-error - spec 008 removed `onDone`; `routes` is required.
            onDone: "childA",
        });
    });

    test("`routes.retry: [{ when, assign }]` is a compile error — only `readonly []` is accepted", () => {
        defineCompoundMode<
            Ctx,
            Events,
            undefined,
            { childA: typeof childA }
        >({
            initial: "childA",
            modes: { childA },
            // @ts-expect-error - `routes.retry` is constrained to `readonly []`.
            routes: {
                achieved: { target: "childA" },
                retry: [{ when: () => true }],
                abandoned: { target: "childA" },
            },
        });
    });

    test("missing `routes` field is a compile error", () => {
        defineCompoundMode<
            Ctx,
            Events,
            undefined,
            { childA: typeof childA }
        >({
            initial: "childA",
            modes: { childA },
            // @ts-expect-error - `routes` is required on CompoundMode.
        });
    });
});

describe("CompoundMode.routes — `when(payload)` types follow `output?`", () => {
    test("with `output: () => { score: number }`, `routes.achieved.when` sees `payload: { score: number }`", () => {
        defineCompoundMode<
            Ctx,
            Events,
            undefined,
            { childA: typeof childA },
            { score: number }
        >({
            initial: "childA",
            modes: { childA },
            output: () => ({ score: 1 }),
            routes: {
                achieved: {
                    when: (payload) => {
                        expectTypeOf(payload).toEqualTypeOf<{ score: number }>();
                        return payload.score > 0;
                    },
                    target: "childA",
                },
                retry: [],
                abandoned: { target: "childA" },
            },
        });
    });

    test("without `output`, `routes.achieved.when` sees `payload: undefined`", () => {
        defineCompoundMode<
            Ctx,
            Events,
            undefined,
            { childA: typeof childA }
        >({
            initial: "childA",
            modes: { childA },
            routes: {
                achieved: {
                    when: (payload) => {
                        expectTypeOf(payload).toEqualTypeOf<undefined>();
                        return payload === undefined;
                    },
                    target: "childA",
                },
                retry: [],
                abandoned: { target: "childA" },
            },
        });
    });

    test("`routes.error.when` sees `error: unknown` regardless of `output?`", () => {
        defineCompoundMode<
            Ctx,
            Events,
            undefined,
            { childA: typeof childA },
            { score: number }
        >({
            initial: "childA",
            modes: { childA },
            output: () => ({ score: 1 }),
            routes: {
                achieved: { target: "childA" },
                retry: [],
                abandoned: { target: "childA" },
                error: {
                    when: (error) => {
                        expectTypeOf(error).toEqualTypeOf<unknown>();
                        return error instanceof Error;
                    },
                    target: "childA",
                },
            },
        });
    });
});

describe("CompoundMode.routes — END target is accepted at every bucket", () => {
    test("`target: END` typechecks in achieved / abandoned / error", () => {
        defineCompoundMode<
            Ctx,
            Events,
            undefined,
            { childA: typeof childA }
        >({
            initial: "childA",
            modes: { childA },
            routes: {
                achieved: { target: END },
                retry: [],
                abandoned: { target: END },
                error: { target: END },
            },
        });
    });
});
