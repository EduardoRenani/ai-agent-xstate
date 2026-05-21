// Phase 4 type tests for the `when` / `assign` callback argument shapes.
// Spec §"Type contract": `when` / `assign` in `routes.achieved/retry/abandoned`
// see `payload: TPayload`; in `routes.error` they see `error: unknown`.
// `context` is always `TContext` in both.

import { describe, expectTypeOf, test } from "vitest";

import type {
    ErrorEntry,
    ExitEntry,
    RetryEntry,
} from "../../src/types.ts";

type Ctx = { messages: readonly string[]; count: number };
type P = { intent: "greeting" | "general"; confidence: number };

describe("ExitEntry callbacks (achieved / abandoned)", () => {
    test("`when` receives the typed payload", () => {
        const entry: ExitEntry<Ctx, P> = {
            when: (payload) => {
                expectTypeOf(payload).toEqualTypeOf<P>();
                return payload.intent === "greeting";
            },
            target: "greetings",
        };
        expectTypeOf(entry).toMatchTypeOf<ExitEntry<Ctx, P>>();
    });

    test("`assign` receives `{ context, payload }` with the right types", () => {
        const entry: ExitEntry<Ctx, P> = {
            target: "next",
            assign: ({ context, payload }) => {
                expectTypeOf(context).toEqualTypeOf<Ctx>();
                expectTypeOf(payload).toEqualTypeOf<P>();
                return { count: context.count + 1 };
            },
        };
        expectTypeOf(entry).toMatchTypeOf<ExitEntry<Ctx, P>>();
    });
});

describe("RetryEntry callbacks", () => {
    test("`when` receives the typed payload (same as Exit)", () => {
        const entry: RetryEntry<Ctx, P> = {
            when: (payload) => {
                expectTypeOf(payload).toEqualTypeOf<P>();
                return payload.confidence < 0.5;
            },
        };
        expectTypeOf(entry).toMatchTypeOf<RetryEntry<Ctx, P>>();
    });

    test("`assign` receives `{ context, payload }`", () => {
        const entry: RetryEntry<Ctx, P> = {
            assign: ({ context, payload }) => {
                expectTypeOf(context).toEqualTypeOf<Ctx>();
                expectTypeOf(payload).toEqualTypeOf<P>();
                return { count: context.count + 1 };
            },
        };
        expectTypeOf(entry).toMatchTypeOf<RetryEntry<Ctx, P>>();
    });
});

describe("ErrorEntry callbacks", () => {
    test("`when` receives `error: unknown`, NOT a payload", () => {
        const entry: ErrorEntry<Ctx> = {
            when: (error) => {
                expectTypeOf(error).toEqualTypeOf<unknown>();
                return error instanceof Error;
            },
            target: "fallback",
        };
        expectTypeOf(entry).toMatchTypeOf<ErrorEntry<Ctx>>();
    });

    test("`assign` receives `{ context, error }`", () => {
        const entry: ErrorEntry<Ctx> = {
            target: "fallback",
            assign: ({ context, error }) => {
                expectTypeOf(context).toEqualTypeOf<Ctx>();
                expectTypeOf(error).toEqualTypeOf<unknown>();
                return { count: context.count + 1 };
            },
        };
        expectTypeOf(entry).toMatchTypeOf<ErrorEntry<Ctx>>();
    });
});
