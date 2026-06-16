// Spec 008 runtime verification — CompoundMode owns a four-bucket `routes`
// surface mirroring `Mode.routes`. These tests exercise each item in spec
// 008 §Verification.2 (runtime tests).

import { createActor, type AnyStateMachine } from "xstate";
import { describe, expect, test } from "vitest";

import { defineAgent } from "../src/defineAgent.ts";
import { defineMode } from "../src/defineMode.ts";
import { defineCompoundMode } from "../src/defineCompoundMode.ts";
import { END, RE_THROW } from "../src/types.ts";
import type { Agent, ModeResult } from "../src/types.ts";

// SPEC 012 §Seam 1: `defineAgent` now returns the opaque `Agent` handle. These
// tests drive the compiled carrier through `createActor` directly to inspect
// lowering internals, so they unwrap `carrier` the way `startAgent` does.
function carrierOf<C, E extends { type: string }>(agent: Agent<C, E>): AnyStateMachine {
    return agent.carrier as AnyStateMachine;
}

type Events = { type: "GO" };

async function settle(): Promise<void> {
    for (let i = 0; i < 40; i += 1) {
        await new Promise<void>((r) => queueMicrotask(r));
    }
}

// SPEC 011: a leaf is a mini-compound, so raw `snapshot.value` is nested
// (`{ done: "$wait" }`); read the top-level mode name. Same mode-level assertion
// as the pre-011 flat string.
const modeOf = (value: unknown): string =>
    typeof value === "string" ? value : Object.keys(value as object)[0];

// SPEC 011: terminal sink — an event-mode awaiting no events parks forever; its
// self-targeting `routes` are unreachable scaffolding. Replaces `{ on: {} }`.
const sink = <C>(self: string) =>
    defineMode<C, Events>({
        start: "event",
        events: [],
        input: () => null,
        behavior: async () => ({ outcome: "achieved", payload: undefined }),
        routes: { achieved: { target: self }, abandoned: { target: self } },
    });

describe("compound routes — per-bucket dispatch (achieved / abandoned)", () => {
    test("child END from `achieved` and `abandoned` lower to distinct final substates; compound onDone[] dispatches per bucket", async () => {
        type Ctx = { last: string };

        // Two children: one ends via achieved, one via abandoned.
        const winning = defineMode<Ctx, Events, undefined>({
            input: () => null,
            behavior: async () =>
                ({ outcome: "achieved", payload: undefined } satisfies ModeResult<undefined>),
            routes: {
                achieved: { target: END },
                abandoned: { target: END },
            },
        });
        const losing = defineMode<Ctx, Events, undefined>({
            input: () => null,
            behavior: async () =>
                ({ outcome: "abandoned", payload: undefined } satisfies ModeResult<undefined>),
            routes: {
                achieved: { target: END },
                abandoned: { target: END },
            },
        });

        const winGroup = defineCompoundMode<Ctx, Events, undefined, { winning: typeof winning }>({
            initial: "winning",
            modes: { winning },
            routes: {
                achieved: { target: "good", assign: () => ({ last: "win-achieved" }) },
                abandoned: { target: "bad", assign: () => ({ last: "win-abandoned" }) },
            },
        });
        const loseGroup = defineCompoundMode<Ctx, Events, undefined, { losing: typeof losing }>({
            initial: "losing",
            modes: { losing },
            routes: {
                achieved: { target: "good", assign: () => ({ last: "lose-achieved" }) },
                abandoned: { target: "bad", assign: () => ({ last: "lose-abandoned" }) },
            },
        });
        const good = sink<Ctx>("good");
        const bad = sink<Ctx>("bad");

        // We assert via two separate agents to keep transitions linear.
        const winMachine = defineAgent<Ctx, Events, {
            winGroup: typeof winGroup;
            good: typeof good;
            bad: typeof bad;
        }>({
            id: "win",
            initial: "winGroup",
            context: { last: "" },
            events: {} as Events,
            modes: { winGroup, good, bad },
        });

        const winActor = createActor(carrierOf(winMachine)).start();
        await settle();
        const winSnap = winActor.getSnapshot();
        expect(modeOf(winSnap.value)).toBe("good");
        expect(winSnap.context.last).toBe("win-achieved");
        winActor.stop();

        const loseMachine = defineAgent<Ctx, Events, {
            loseGroup: typeof loseGroup;
            good: typeof good;
            bad: typeof bad;
        }>({
            id: "lose",
            initial: "loseGroup",
            context: { last: "" },
            events: {} as Events,
            modes: { loseGroup, good, bad },
        });
        const loseActor = createActor(carrierOf(loseMachine)).start();
        await settle();
        const loseSnap = loseActor.getSnapshot();
        expect(modeOf(loseSnap.value)).toBe("bad");
        expect(loseSnap.context.last).toBe("lose-abandoned");
        loseActor.stop();
    });

    test("compound onDone[] guards by outcome — achieved entry does not fire on abandoned, and vice versa", async () => {
        // The compound declares both achieved and abandoned routes. The
        // child exits via abandoned. We assert only the abandoned route's
        // `assign` fired.
        type Ctx = { picked: string };

        const inner = defineMode<Ctx, Events, undefined>({
            input: () => null,
            behavior: async () =>
                ({ outcome: "abandoned", payload: undefined } satisfies ModeResult<undefined>),
            routes: {
                achieved: { target: END },
                abandoned: { target: END },
            },
        });
        const group = defineCompoundMode<Ctx, Events, undefined, { inner: typeof inner }>({
            initial: "inner",
            modes: { inner },
            routes: {
                achieved: { target: "done", assign: () => ({ picked: "achieved-fired" }) },
                abandoned: { target: "done", assign: () => ({ picked: "abandoned-fired" }) },
            },
        });
        const done = sink<Ctx>("done");

        const machine = defineAgent<Ctx, Events, {
            group: typeof group;
            done: typeof done;
        }>({
            id: "guard",
            initial: "group",
            context: { picked: "" },
            events: {} as Events,
            modes: { group, done },
        });

        const actor = createActor(carrierOf(machine)).start();
        await settle();
        expect(modeOf(actor.getSnapshot().value)).toBe("done");
        expect(actor.getSnapshot().context.picked).toBe("abandoned-fired");
        actor.stop();
    });
});

describe("compound routes — `output` callback wiring", () => {
    test("`output` runs after the child's `assign`; payload threads into the compound's onDone[]", async () => {
        // The child's `assign` increments a counter; the compound's `output`
        // reads it. The compound's `routes.achieved.when` then routes based
        // on the produced payload, confirming the chain end-to-end.
        type Ctx = { counter: number; landed: string };

        const work = defineMode<Ctx, Events, undefined>({
            input: () => null,
            behavior: async () =>
                ({ outcome: "achieved", payload: undefined } satisfies ModeResult<undefined>),
            routes: {
                achieved: {
                    target: END,
                    // The child's assign runs before the compound's
                    // `output` callback reads the context.
                    assign: ({ context }) => ({ counter: context.counter + 7 }),
                },
                abandoned: { target: END },
            },
        });
        const group = defineCompoundMode<
            Ctx,
            Events,
            undefined,
            { work: typeof work },
            { counterPlus: number }
        >({
            initial: "work",
            modes: { work },
            output: ({ context }) => ({ counterPlus: context.counter + 1 }),
            routes: {
                achieved: [
                    {
                        when: (p) => p.counterPlus >= 100,
                        target: "big",
                        assign: ({ payload }) => ({ landed: `big-${payload.counterPlus}` }),
                    },
                    {
                        target: "small",
                        assign: ({ payload }) => ({ landed: `small-${payload.counterPlus}` }),
                    },
                ],
                abandoned: { target: "small" },
            },
        });
        const big = sink<Ctx>("big");
        const small = sink<Ctx>("small");

        const machine = defineAgent<Ctx, Events, {
            group: typeof group;
            big: typeof big;
            small: typeof small;
        }>({
            id: "output",
            initial: "group",
            context: { counter: 0, landed: "" },
            events: {} as Events,
            modes: { group, big, small },
        });

        const actor = createActor(carrierOf(machine)).start();
        await settle();
        // child assigns counter 0 → 7; compound output yields counter+1 = 8.
        // 8 < 100, so the default branch fires.
        const snap = actor.getSnapshot();
        expect(modeOf(snap.value)).toBe("small");
        expect(snap.context.landed).toBe("small-8");
        expect(snap.context.counter).toBe(7);
        actor.stop();
    });

    test("`output` is NOT invoked on a `stay:replay` continuation — the compound never finalizes from a replay", async () => {
        // The child replays twice, then achieves. The compound's `output`
        // counts how many times it ran; we assert it ran exactly once (on
        // the achieved exit), proving a continuation never triggers a compound
        // finalisation.
        type Ctx = { attempts: number; outputRuns: number };

        // SPEC 011: the old `outcome: "retry"` continuation is now
        // `stay: "replay"`, dispatched by the `stay` map (assign only, no target).
        const flaky = defineMode<Ctx, Events, undefined>({
            input: ({ context }) => context.attempts,
            behavior: async ({ input }) => {
                const n = input as number;
                return n < 2
                    ? ({ stay: "replay", payload: undefined } satisfies ModeResult<undefined>)
                    : ({ outcome: "achieved", payload: undefined } satisfies ModeResult<undefined>);
            },
            routes: {
                achieved: { target: END },
                abandoned: { target: END },
            },
            stay: { replay: { assign: ({ context }) => ({ attempts: context.attempts + 1 }) } },
        });

        // The `output` callback's side-effect — bumping `outputRuns` — is
        // observed via a closure-bound mutable variable (output cbs must
        // remain pure of XState assigns).
        let outputCalls = 0;
        const group = defineCompoundMode<Ctx, Events, undefined, { flaky: typeof flaky }>({
            initial: "flaky",
            modes: { flaky },
            output: () => {
                outputCalls += 1;
                return undefined;
            },
            routes: {
                achieved: { target: "done" },
                abandoned: { target: "done" },
            },
        });
        const done = sink<Ctx>("done");

        const machine = defineAgent<Ctx, Events, {
            group: typeof group;
            done: typeof done;
        }>({
            id: "no-output-on-retry",
            initial: "group",
            context: { attempts: 0, outputRuns: 0 },
            events: {} as Events,
            modes: { group, done },
        });

        // Each replay re-invokes `behavior` — several microtask turns through
        // the XState scheduler before `done` is reached. Wait by subscription.
        const actor = createActor(carrierOf(machine)).start();
        await new Promise<void>((resolve) => {
            const sub = actor.subscribe((snap) => {
                if (modeOf(snap.value) === "done") {
                    sub.unsubscribe();
                    resolve();
                }
            });
        });
        expect(modeOf(actor.getSnapshot().value)).toBe("done");
        expect(actor.getSnapshot().context.attempts).toBe(2);
        expect(outputCalls).toBe(1);
        actor.stop();
    });

    test("`output` sees the compound-local context slice, not the parent's full context", async () => {
        // The compound narrows context to `{ messages, attempts }`. The
        // `output` callback must see exactly that slice — not the root
        // `Ctx` that also carries `secret`.
        type RootCtx = { messages: readonly string[]; secret: string };

        const inner = defineMode<{ messages: readonly string[]; attempts: number }, Events, undefined>({
            input: () => null,
            behavior: async () =>
                ({ outcome: "achieved", payload: undefined } satisfies ModeResult<undefined>),
            routes: {
                achieved: { target: END },
                abandoned: { target: END },
            },
        });

        let seenKeys: readonly string[] = [];
        const group = defineCompoundMode<
            RootCtx,
            Events,
            { inherit: readonly ["messages"]; local: { attempts: number } },
            { inner: typeof inner },
            { len: number }
        >({
            context: { inherit: ["messages"] as const, local: { attempts: 0 } },
            initial: "inner",
            modes: { inner },
            output: ({ context }) => {
                seenKeys = Object.keys(context as object);
                return { len: (context as { messages: readonly string[] }).messages.length };
            },
            routes: {
                achieved: { target: "done" },
                abandoned: { target: "done" },
            },
        });
        const done = sink<RootCtx>("done");

        const machine = defineAgent<RootCtx, Events, {
            group: typeof group;
            done: typeof done;
        }>({
            id: "slice-view",
            initial: "group",
            context: { messages: ["a", "b"], secret: "shh" },
            events: {} as Events,
            modes: { group, done },
        });

        const actor = createActor(carrierOf(machine)).start();
        await settle();
        expect(modeOf(actor.getSnapshot().value)).toBe("done");
        // Slice view: inherited `messages` + local `attempts`. No `secret`.
        expect([...seenKeys].sort()).toEqual(["attempts", "messages"]);
        actor.stop();
    });
});

describe("compound routes — error bubble propagation", () => {
    test("child `routes.error.target = END` + compound omits `routes.error` ⇒ re-throws above the compound", async () => {
        type Ctx = { ok: boolean };

        const exploder = defineMode<Ctx, Events, undefined>({
            input: () => null,
            behavior: async () => {
                throw new RangeError("boom");
            },
            routes: {
                achieved: { target: END },
                abandoned: { target: END },
                // The user explicitly routes the error bucket to END;
                // because the compound omits `routes.error`, this rewrites
                // to a throw above the compound at compile time.
                error: { target: END },
            },
        });
        const group = defineCompoundMode<Ctx, Events, undefined, { exploder: typeof exploder }>({
            initial: "exploder",
            modes: { exploder },
            routes: {
                achieved: { target: "done" },
                abandoned: { target: "done" },
                // No `routes.error` here → child END_ERROR re-throws.
            },
        });
        const done = sink<Ctx>("done");

        const machine = defineAgent<Ctx, Events, {
            group: typeof group;
            done: typeof done;
        }>({
            id: "rethrow-above",
            initial: "group",
            context: { ok: false },
            events: {} as Events,
            modes: { group, done },
        });

        const errors: unknown[] = [];
        const actor = createActor(carrierOf(machine));
        actor.subscribe({ error: (e) => errors.push(e) });
        actor.start();
        await settle();

        expect(errors.length).toBeGreaterThan(0);
        expect(errors[0]).toBeInstanceOf(RangeError);
        expect((errors[0] as Error).message).toBe("boom");
    });

    test("child `routes.error.target = END` + compound `routes.error` present ⇒ routes through the bucket; `when` sees the raw error", async () => {
        type Ctx = { tag: string };

        const exploder = defineMode<Ctx, Events, undefined>({
            input: () => null,
            behavior: async () => {
                throw new TypeError("typed-boom");
            },
            routes: {
                achieved: { target: END },
                abandoned: { target: END },
                error: { target: END },
            },
        });
        const group = defineCompoundMode<Ctx, Events, undefined, { exploder: typeof exploder }>({
            initial: "exploder",
            modes: { exploder },
            routes: {
                achieved: { target: "good" },
                abandoned: { target: "bad" },
                error: [
                    {
                        when: (e) => e instanceof TypeError,
                        target: "typeLanded",
                        assign: ({ error }) => ({ tag: `type:${(error as Error).message}` }),
                    },
                    {
                        target: "otherLanded",
                        assign: () => ({ tag: "other" }),
                    },
                ],
            },
        });
        const good = sink<Ctx>("good");
        const bad = sink<Ctx>("bad");
        const typeLanded = sink<Ctx>("typeLanded");
        const otherLanded = sink<Ctx>("otherLanded");

        const machine = defineAgent<Ctx, Events, {
            group: typeof group;
            good: typeof good;
            bad: typeof bad;
            typeLanded: typeof typeLanded;
            otherLanded: typeof otherLanded;
        }>({
            id: "error-bucket",
            initial: "group",
            context: { tag: "" },
            events: {} as Events,
            modes: { group, good, bad, typeLanded, otherLanded },
        });

        const actor = createActor(carrierOf(machine)).start();
        await settle();
        const snap = actor.getSnapshot();
        expect(modeOf(snap.value)).toBe("typeLanded");
        expect(snap.context.tag).toBe("type:typed-boom");
        actor.stop();
    });

    test("compound `routes.error` with RE_THROW re-throws the original error", async () => {
        type Ctx = { reached: boolean };

        const exploder = defineMode<Ctx, Events, undefined>({
            input: () => null,
            behavior: async () => {
                throw new Error("propagate-me");
            },
            routes: {
                achieved: { target: END },
                abandoned: { target: END },
                error: { target: END },
            },
        });
        const group = defineCompoundMode<Ctx, Events, undefined, { exploder: typeof exploder }>({
            initial: "exploder",
            modes: { exploder },
            routes: {
                achieved: { target: "done" },
                abandoned: { target: "done" },
                error: { target: RE_THROW },
            },
        });
        const done = sink<Ctx>("done");

        const machine = defineAgent<Ctx, Events, {
            group: typeof group;
            done: typeof done;
        }>({
            id: "rethrow-bucket",
            initial: "group",
            context: { reached: false },
            events: {} as Events,
            modes: { group, done },
        });

        const errors: unknown[] = [];
        const actor = createActor(carrierOf(machine));
        actor.subscribe({ error: (e) => errors.push(e) });
        actor.start();
        await settle();

        expect(errors.length).toBeGreaterThan(0);
        expect((errors[0] as Error).message).toBe("propagate-me");
    });
});

describe("compound routes — event-mode child END lands in the `achieved` bucket", () => {
    test("an event-mode child whose achieved route targets END lands in the compound's achieved bucket", async () => {
        type Ctx = { picked: string };

        // SPEC 011: the old passive child (`on: { GO: { target: END } }`) is now
        // an event-mode — it parks on entry, runs its behavior on GO, and its
        // achieved route targets END → the compound's `achieved` bucket. (The
        // pre-011 "passive END defaults to achieved" rule is gone; an event-mode
        // routes its outcome explicitly.)
        const waiting = defineMode<Ctx, Events, undefined>({
            start: "event",
            events: ["GO"],
            input: () => null,
            behavior: async () => ({ outcome: "achieved", payload: undefined }),
            routes: {
                achieved: { target: END },
                abandoned: { target: END },
            },
        });
        const group = defineCompoundMode<Ctx, Events, undefined, { waiting: typeof waiting }>({
            initial: "waiting",
            modes: { waiting },
            routes: {
                achieved: { target: "done", assign: () => ({ picked: "achieved" }) },
                // If the child's achieved END were ever routed to the abandoned
                // bucket, this would fire instead. The test fails (wrong sibling
                // + wrong tag) if that regression appears.
                abandoned: { target: "fallback", assign: () => ({ picked: "abandoned" }) },
            },
        });
        const done = sink<Ctx>("done");
        const fallback = sink<Ctx>("fallback");

        const machine = defineAgent<Ctx, Events, {
            group: typeof group;
            done: typeof done;
            fallback: typeof fallback;
        }>({
            id: "passive-end",
            initial: "group",
            context: { picked: "" },
            events: {} as Events,
            modes: { group, done, fallback },
        });

        const actor = createActor(carrierOf(machine)).start();
        actor.send({ type: "GO" });
        await settle(); // event-mode behavior is async (was a sync passive transition)
        const snap = actor.getSnapshot();
        expect(modeOf(snap.value)).toBe("done");
        expect(snap.context.picked).toBe("achieved");
        actor.stop();
    });
});
