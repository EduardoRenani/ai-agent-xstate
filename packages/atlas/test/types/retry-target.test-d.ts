// Phase 4 type test for `RetryEntry`. Spec §"Type contract":
// retry is always a self-loop on the leaf, so `target` is NOT a field on
// `RetryEntry`. Supplying it must be a compile error.

import { describe, expectTypeOf, test } from "vitest";

import type { RetryEntry } from "../../src/types.ts";

type Ctx = { messages: readonly string[] };
type P = { intent: "greeting" | "general" };

describe("RetryEntry has no `target` field", () => {
    test("a plain `{}` is a valid RetryEntry", () => {
        const ok: RetryEntry<Ctx, P> = {};
        expectTypeOf(ok).toMatchTypeOf<RetryEntry<Ctx, P>>();
    });

    test("supplying `target` is a compile error", () => {
        const bad: RetryEntry<Ctx, P> = {
            // @ts-expect-error - retry is always a self-loop; `target` is not allowed
            target: "elsewhere",
        };
        expectTypeOf(bad).toMatchTypeOf<RetryEntry<Ctx, P>>();
    });
});
