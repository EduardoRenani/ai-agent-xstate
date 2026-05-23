// Phase 4 type tests for compound-local context (`CompoundContext` /
// `LocalContextOf`). Spec §`defineCompoundMode` "Lexical scoping" + §"Type contract".

import { describe, expectTypeOf, test } from "vitest";

import type {
    CompoundContext,
    LocalContextOf,
} from "../../src/types.ts";

type Parent = {
    messages: readonly string[];
    user: { id: string };
    apiKey: string;
};

describe("LocalContextOf — inherit + local", () => {
    test("a CompoundMode with `inherit: ['messages']` and `local: { count }` exposes only those", () => {
        type Ctx = CompoundContext<Parent, readonly ["messages"], { count: number }>;
        type ChildContext = LocalContextOf<Parent, Ctx>;

        const ok: ChildContext = { messages: [], count: 0 };
        expectTypeOf(ok).toMatchTypeOf<{ messages: readonly string[]; count: number }>();
    });

    test("non-inherited parent keys are NOT in the child context", () => {
        type Ctx = CompoundContext<Parent, readonly ["messages"], { count: number }>;
        type ChildContext = LocalContextOf<Parent, Ctx>;

        // @ts-expect-error - `apiKey` was not inherited
        const bad: ChildContext = { messages: [], count: 0, apiKey: "secret" };
        expectTypeOf(bad).toMatchTypeOf<ChildContext>();
    });

    test("omitting `context` (TCtx = undefined) keeps the FULL parent context visible", () => {
        type ChildContext = LocalContextOf<Parent, undefined>;
        expectTypeOf<ChildContext>().toEqualTypeOf<Parent>();
    });
});

describe("Nested compound — `inherit` scopes against the IMMEDIATE enclosing compound", () => {
    // Outer compound: inherit ["messages"], add local { outerCount: number }
    type OuterCtx = CompoundContext<Parent, readonly ["messages"], { outerCount: number }>;
    type OuterChildContext = LocalContextOf<Parent, OuterCtx>;
    //    ^ = { messages: readonly string[]; outerCount: number }

    // Inner compound, nested INSIDE the outer compound. Its `TParent` is the
    // outer's child context, not `Parent`. It can inherit `outerCount` —
    // that key only exists in the outer's locals.
    type InnerCtx = CompoundContext<OuterChildContext, readonly ["outerCount"], { attempts: number }>;
    type InnerChildContext = LocalContextOf<OuterChildContext, InnerCtx>;

    test("inner child sees `outerCount` (inherited) and `attempts` (local)", () => {
        const ok: InnerChildContext = { outerCount: 0, attempts: 0 };
        expectTypeOf(ok).toMatchTypeOf<{ outerCount: number; attempts: number }>();
    });

    test("inner child does NOT see `messages` (not inherited at the inner level)", () => {
        // @ts-expect-error - `messages` was not inherited by the inner compound
        const bad: InnerChildContext = { outerCount: 0, attempts: 0, messages: [] };
        expectTypeOf(bad).toMatchTypeOf<InnerChildContext>();
    });

    test("inner compound CANNOT inherit `apiKey` — that key is invisible at its level", () => {
        // The outer compound did not inherit `apiKey`, so the inner cannot
        // reach it. Encoded as: `["apiKey"]` is not assignable to the
        // `ReadonlyArray<keyof OuterChildContext & string>` constraint.
        // @ts-expect-error - `apiKey` is not a key of the outer's exposed context
        type _Bad = CompoundContext<OuterChildContext, readonly ["apiKey"], { attempts: number }>;
        expectTypeOf<_Bad>().not.toBeUndefined();
    });
});
