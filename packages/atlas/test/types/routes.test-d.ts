// Phase 4 type tests for `RouteList<E>` shape and `Routes<C, P>` per-key
// variance. Spec §"Type contract" — the `RouteList` constraint
// ("non-last entries carry `when`; last entry omits it; `[]` is
// unrepresentable for achieved/abandoned/error").

import { describe, expectTypeOf, test } from "vitest";

import { END } from "../../src/types.ts";
import type {
    ExitEntry,
    RetryEntry,
    RouteList,
    Routes,
} from "../../src/types.ts";

type Ctx = { messages: readonly string[] };
type P = { intent: "greeting" | "general" };

describe("RouteList<ExitEntry> shape", () => {
    test("accepts [only-default]", () => {
        const ok = [
            { target: "next" as const },
        ] as const;
        expectTypeOf(ok).toMatchTypeOf<RouteList<ExitEntry<Ctx, P>>>();
    });

    test("accepts [guarded, default]", () => {
        const ok = [
            { when: (p: P) => p.intent === "greeting", target: "greetings" as const },
            { target: "improvising" as const },
        ] as const;
        expectTypeOf(ok).toMatchTypeOf<RouteList<ExitEntry<Ctx, P>>>();
    });

    test("accepts [guarded, guarded, default] — multiple guarded entries", () => {
        const ok = [
            { when: (p: P) => p.intent === "greeting", target: "greetings" as const },
            { when: (p: P) => p.intent === "general", target: "improvising" as const },
            { target: END },
        ] as const;
        expectTypeOf(ok).toMatchTypeOf<RouteList<ExitEntry<Ctx, P>>>();
    });

    test("rejects [] for ExitEntry-bearing keys", () => {
        const empty = [] as const;
        // @ts-expect-error - empty array is unrepresentable as RouteList
        expectTypeOf(empty).toMatchTypeOf<RouteList<ExitEntry<Ctx, P>>>();
    });

    test("rejects unguarded non-last entry (would shadow later entries)", () => {
        const bad = [
            { target: "early" as const },                                          // missing `when`
            { when: (p: P) => p.intent === "general", target: "late" as const },
            { target: "default" as const },
        ] as const;
        // @ts-expect-error - non-last entry must carry `when`
        expectTypeOf(bad).toMatchTypeOf<RouteList<ExitEntry<Ctx, P>>>();
    });

    test("rejects guarded tail (default must omit `when`)", () => {
        const bad = [
            { when: (p: P) => p.intent === "greeting", target: "greetings" as const },
            { when: (p: P) => p.intent === "general", target: "improvising" as const },
        ] as const;
        // @ts-expect-error - last entry must omit `when`
        expectTypeOf(bad).toMatchTypeOf<RouteList<ExitEntry<Ctx, P>>>();
    });
});

describe("Routes<C, P>.retry variance", () => {
    test("accepts a single RetryEntry object (no `target`)", () => {
        const r: Routes<Ctx, P>["retry"] = {};
        expectTypeOf(r).toMatchTypeOf<RetryEntry<Ctx, P> | readonly [] | RouteList<RetryEntry<Ctx, P>>>();
    });

    test("accepts `readonly []` (the no-special-handling shorthand)", () => {
        const r: Routes<Ctx, P>["retry"] = [] as const;
        expectTypeOf(r).toMatchTypeOf<RetryEntry<Ctx, P> | readonly [] | RouteList<RetryEntry<Ctx, P>>>();
    });

    test("accepts a RouteList<RetryEntry>", () => {
        const r: Routes<Ctx, P>["retry"] = [
            { when: (p: P) => p.intent === "greeting" },
            {},
        ] as const;
        expectTypeOf(r).toMatchTypeOf<RetryEntry<Ctx, P> | readonly [] | RouteList<RetryEntry<Ctx, P>>>();
    });
});
