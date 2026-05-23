// Phase 4 type tests for the active/passive discriminated union and the
// mandatory keys of `Routes<C, P>`. Spec §"Type contract":
// `ActiveModeConfig` and `PassiveModeConfig` are mutually exclusive;
// `achieved` / `retry` / `abandoned` are mandatory inside `routes`; `error`
// is optional.

import { describe, test } from "vitest";

import { defineMode } from "../../src/defineMode.ts";
import type { ModeOutput } from "../../src/types.ts";

type Ctx = { messages: readonly string[] };
type Events = { type: "MESSAGE"; text: string };
type P = { ok: boolean };

describe("active / passive variants are mutually exclusive", () => {
    test("active variant: input + behavior + routes compiles", () => {
        defineMode<Ctx, Events, P>({
            input: ({ context }) => context.messages,
            behavior: async () => ({ outcome: "achieved", payload: { ok: true } } satisfies ModeOutput<P>),
            routes: {
                achieved: { target: "next" },
                retry: {},
                abandoned: { target: "abandoned" },
            },
        });
    });

    test("passive variant: `on` only compiles", () => {
        defineMode<Ctx, Events>({
            on: {
                MESSAGE: { target: "thinking" },
            },
        });
    });

    test("mixing `behavior` and `on` is a compile error", () => {
        defineMode<Ctx, Events, P>({
            // @ts-expect-error - active and passive variants are mutually exclusive
            input: ({ context }) => context.messages,
            behavior: async () => ({ outcome: "achieved", payload: { ok: true } } satisfies ModeOutput<P>),
            routes: {
                achieved: { target: "next" },
                retry: {},
                abandoned: { target: "abandoned" },
            },
            on: { MESSAGE: { target: "next" } },
        });
    });
});

describe("Routes mandatory-key check", () => {
    test("missing `achieved` is a compile error", () => {
        defineMode<Ctx, Events, P>({
            input: ({ context }) => context.messages,
            behavior: async () => ({ outcome: "achieved", payload: { ok: true } } satisfies ModeOutput<P>),
            // @ts-expect-error - `achieved` is mandatory
            routes: {
                retry: {},
                abandoned: { target: "abandoned" },
            },
        });
    });

    test("missing `retry` is a compile error", () => {
        defineMode<Ctx, Events, P>({
            input: ({ context }) => context.messages,
            behavior: async () => ({ outcome: "achieved", payload: { ok: true } } satisfies ModeOutput<P>),
            // @ts-expect-error - `retry` is mandatory
            routes: {
                achieved: { target: "next" },
                abandoned: { target: "abandoned" },
            },
        });
    });

    test("missing `abandoned` is a compile error", () => {
        defineMode<Ctx, Events, P>({
            input: ({ context }) => context.messages,
            behavior: async () => ({ outcome: "achieved", payload: { ok: true } } satisfies ModeOutput<P>),
            // @ts-expect-error - `abandoned` is mandatory
            routes: {
                achieved: { target: "next" },
                retry: {},
            },
        });
    });

    test("missing `error` compiles (it is optional — defaults to re-throw)", () => {
        defineMode<Ctx, Events, P>({
            input: ({ context }) => context.messages,
            behavior: async () => ({ outcome: "achieved", payload: { ok: true } } satisfies ModeOutput<P>),
            routes: {
                achieved: { target: "next" },
                retry: {},
                abandoned: { target: "abandoned" },
            },
        });
    });
});
