// Phase 4 type tests for `RouteTarget` / `ErrorRouteTarget`. Spec
// §"Type contract": `RE_THROW` is valid only on `ErrorEntry.target`.

import { describe, expectTypeOf, test } from "vitest";

import { END, RE_THROW } from "../../src/types.ts";
import type {
    ErrorEntry,
    ErrorRouteTarget,
    ExitEntry,
    RouteTarget,
} from "../../src/types.ts";

type Ctx = { messages: readonly string[] };
type P = { ok: boolean };

describe("RouteTarget (achieved / retry / abandoned)", () => {
    test("accepts a sibling name string", () => {
        expectTypeOf("sibling" satisfies RouteTarget).toMatchTypeOf<RouteTarget>();
    });

    test("accepts END", () => {
        expectTypeOf(END satisfies RouteTarget).toMatchTypeOf<RouteTarget>();
    });

    test("rejects RE_THROW on a non-error ExitEntry", () => {
        const bad: ExitEntry<Ctx, P> = {
            // @ts-expect-error - RE_THROW is only valid on ErrorEntry.target
            target: RE_THROW,
        };
        expectTypeOf(bad).toMatchTypeOf<ExitEntry<Ctx, P>>();
    });
});

describe("ErrorRouteTarget (error)", () => {
    test("accepts a sibling name string", () => {
        expectTypeOf("sibling" satisfies ErrorRouteTarget).toMatchTypeOf<ErrorRouteTarget>();
    });

    test("accepts END", () => {
        expectTypeOf(END satisfies ErrorRouteTarget).toMatchTypeOf<ErrorRouteTarget>();
    });

    test("accepts RE_THROW", () => {
        expectTypeOf(RE_THROW satisfies ErrorRouteTarget).toMatchTypeOf<ErrorRouteTarget>();
        const ok: ErrorEntry<Ctx> = { target: RE_THROW };
        expectTypeOf(ok).toMatchTypeOf<ErrorEntry<Ctx>>();
    });
});
