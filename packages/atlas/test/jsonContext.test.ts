// Spec 005 runtime tests for the JSON-context round-trip contract.
// Spec §New Types + §Synthetic compound-local slots + §Verification.
//
// The wrapper promises `JSON.stringify(actor.getSnapshot().context)` produces
// a string that round-trips back to a structurally equal object — covering
// both the user-declared TContext and any synthetic compound-local slots.

import { createActor, type AnyStateMachine } from "xstate";
import { describe, expect, test } from "vitest";

import { defineAgent } from "../src/defineAgent.ts";
import { defineMode } from "../src/defineMode.ts";
import { defineCompoundMode } from "../src/defineCompoundMode.ts";
import type { Agent, ModeResult } from "../src/types.ts";

// SPEC 012 §Seam 1: `defineAgent` now returns the opaque `Agent` handle. These
// tests drive the compiled carrier through `createActor` directly to inspect
// lowering internals, so they unwrap `carrier` the way `startAgent` does.
function carrierOf<C, E extends { type: string }>(agent: Agent<C, E>): AnyStateMachine {
    return agent.carrier as AnyStateMachine;
}

type Events = { type: "ADVANCE" } | { type: "MESSAGE"; text: string };

// SPEC 011: there is no more `{ on: {} }` passive leaf. A terminal sink — a mode
// the agent enters and never leaves — is an event-mode that awaits no events, so
// it parks forever; its `routes` are unreachable scaffolding (target self so
// `validateTargets` is satisfied). Observably identical to the old `{ on: {} }`
// sink in these tests, which are only routed INTO and never exited.
const sink = <C>(self: string) =>
    defineMode<C, Events>({
        start: "event",
        events: [],
        input: () => null,
        behavior: async () => ({ outcome: "achieved", payload: undefined }),
        routes: { achieved: { target: self }, abandoned: { target: self } },
    });

// SPEC 011: every mode now lowers to a mini-compound ($run/$wait/$end_*), so raw
// XState `snapshot.value` is nested (`{ idle: "$wait" }`) instead of the flat
// string `"idle"` it was when leaves were plain states. These tests drive the
// raw actor (not `startAgent`, which masks the synthetic substates), so they read
// the top-level mode name off the value. This adapts the wait *mechanism* only —
// the asserted behavior (which mode the agent lands in) is unchanged.
const modeOf = (value: unknown): string =>
    typeof value === "string" ? value : Object.keys(value as object)[0];

describe("JSON.stringify(context) round-trip — no deps leakage", () => {
    test("basic agent context survives stringify/parse to a structurally equal value", async () => {
        type Ctx = { messages: readonly string[]; count: number };
        type Deps = { tag: string };

        const probe = defineMode<Ctx, Events, undefined, Deps>({
            input: ({ context }) => context.messages,
            behavior: async () =>
                ({ outcome: "achieved", payload: undefined } satisfies ModeResult<undefined>),
            routes: {
                achieved: {
                    target: "done",
                    assign: ({ context }) => ({
                        count: context.count + 1,
                        messages: [...context.messages, "ran"],
                    }),
                },
                abandoned: { target: "done" },
            },
        });
        const done = sink<Ctx>("done");

        const machine = defineAgent<Ctx, Events, { probe: typeof probe; done: typeof done }, Deps>({
            id: "json",
            initial: "probe",
            context: { messages: [], count: 0 },
            events: {} as Events,
            deps: { tag: "x" },
            modes: { probe, done },
        });

        const actor = createActor(carrierOf(machine)).start();
        await new Promise((r) => setTimeout(r, 0));
        const snapshot = actor.getSnapshot();
        actor.stop();

        const json = JSON.stringify(snapshot.context);
        const parsed = JSON.parse(json);
        expect(parsed).toEqual({ messages: ["ran"], count: 1 });

        // No deps leaked into context — the JSON contains only TContext.
        expect("tag" in parsed).toBe(false);
    });

    test("optional `undefined` field round-trips through `JSON.stringify` (key dropped)", async () => {
        type Ctx = { a: number; b?: string };

        const probe = defineMode<Ctx, Events, undefined>({
            input: () => null,
            behavior: async () =>
                ({ outcome: "achieved", payload: undefined } satisfies ModeResult<undefined>),
            routes: {
                achieved: { target: "done" },
                abandoned: { target: "done" },
            },
        });
        const done = sink<Ctx>("done");

        const machine = defineAgent<Ctx, Events, { probe: typeof probe; done: typeof done }>({
            id: "json-undef",
            initial: "probe",
            context: { a: 1, b: undefined },
            events: {} as Events,
            modes: { probe, done },
        });

        const actor = createActor(carrierOf(machine)).start();
        await new Promise((r) => setTimeout(r, 0));
        const snapshot = actor.getSnapshot();
        actor.stop();

        const json = JSON.stringify(snapshot.context);
        // `JSON.stringify` drops keys whose value is `undefined` — this is
        // JavaScript's standard semantic, inherited unchanged by the wrapper.
        expect(json).toBe(`{"a":1}`);
        const parsed = JSON.parse(json);
        expect(parsed).toEqual({ a: 1 });
        expect("b" in parsed).toBe(false);
    });
});

describe("synthetic compound-local slot persistence", () => {
    test("outside-the-compound case: slot is cleared on exit; JSON carries only declared TContext", async () => {
        // Compound declares `local: { attempts: 0 }`. The wrapper materializes
        // this as an `__inner_local` key on the root context, set on entry
        // and cleared (→ undefined) on exit. We enter, bump, exit, then check
        // the persisted JSON carries only the user-declared keys.
        const { END } = await import("../src/types.ts");

        type RootCtx = { messages: readonly string[] };
        type ChildCtx = { messages: readonly string[]; attempts: number };

        const innerBump = defineMode<ChildCtx, Events, undefined>({
            input: ({ context }) => context.attempts,
            behavior: async () =>
                ({ outcome: "achieved", payload: undefined } satisfies ModeResult<undefined>),
            routes: {
                achieved: {
                    target: "settled",
                    assign: ({ context }) => ({ attempts: context.attempts + 1 }),
                },
                abandoned: { target: "settled" },
            },
        });
        const innerSettled = defineMode<ChildCtx, Events, undefined>({
            input: () => null,
            behavior: async () =>
                ({ outcome: "achieved", payload: undefined } satisfies ModeResult<undefined>),
            routes: {
                achieved: { target: END },
                abandoned: { target: END },
            },
        });

        const inner = defineCompoundMode<RootCtx, Events,
            { inherit: readonly ["messages"]; local: { attempts: number } },
            { bump: typeof innerBump; settled: typeof innerSettled }
        >({
            context: { inherit: ["messages"] as const, local: { attempts: 0 } },
            initial: "bump",
            modes: { bump: innerBump, settled: innerSettled },
            routes: {
                achieved: { target: "idle" },
                abandoned: { target: "idle" },
            },
        });
        const idle = sink<RootCtx>("idle");

        const machine = defineAgent<RootCtx, Events, { inner: typeof inner; idle: typeof idle }>({
            id: "slot-outside",
            initial: "inner",
            context: { messages: [] },
            events: {} as Events,
            modes: { inner, idle },
        });

        const actor = createActor(carrierOf(machine)).start();

        await new Promise<void>((resolve) => {
            const sub = actor.subscribe((snap) => {
                if (modeOf(snap.value) === "idle") {
                    sub.unsubscribe();
                    resolve();
                }
            });
        });
        const snapshot = actor.getSnapshot();
        actor.stop();

        // Slot is materialized on context but cleared (undefined) post-exit.
        const ctx = snapshot.context as Record<string, unknown>;
        expect("__inner_local" in ctx).toBe(true);
        expect(ctx.__inner_local).toBeUndefined();

        // JSON.stringify drops undefined values — persisted form is only the
        // user-declared TContext.
        const parsed = JSON.parse(JSON.stringify(snapshot.context));
        expect(parsed).toEqual({ messages: [] });
    });
});

describe("`when` predicates still route correctly after spec 005 changes", () => {
    test("a `routes.achieved.when` with the bare `(payload) => boolean` signature picks the right branch", async () => {
        type Ctx = { last: string };
        type P = { tag: "x" | "y" };

        const probe = defineMode<Ctx, Events, P>({
            input: () => null,
            behavior: async () =>
                ({ outcome: "achieved", payload: { tag: "y" } } satisfies ModeResult<P>),
            routes: {
                achieved: [
                    {
                        when: (p) => p.tag === "x",
                        target: "xLanding",
                        assign: () => ({ last: "x-branch" }),
                    },
                    {
                        target: "yLanding",
                        assign: () => ({ last: "y-branch" }),
                    },
                ],
                abandoned: { target: "yLanding" },
            },
        });
        const xLanding = sink<Ctx>("xLanding");
        const yLanding = sink<Ctx>("yLanding");

        const machine = defineAgent<Ctx, Events, {
            probe: typeof probe;
            xLanding: typeof xLanding;
            yLanding: typeof yLanding;
        }>({
            id: "when-bare",
            initial: "probe",
            context: { last: "" },
            events: {} as Events,
            modes: { probe, xLanding, yLanding },
        });

        const actor = createActor(carrierOf(machine)).start();
        await new Promise<void>((resolve) => {
            const sub = actor.subscribe((snap) => {
                if (modeOf(snap.value) === "yLanding") {
                    sub.unsubscribe();
                    resolve();
                }
            });
        });
        expect(actor.getSnapshot().context.last).toBe("y-branch");
        actor.stop();
    });
});
