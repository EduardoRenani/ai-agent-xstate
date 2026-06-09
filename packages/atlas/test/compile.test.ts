// Phase 5.16 runtime tests: final emit — `compile()` composes every slice
// (validators + walk + buildActors + buildActions + buildActiveState with
// parent lift + per-level END injection) and hands the result to
// `setup({...}).createMachine({...})`. `defineAgent` returns that machine.
//
// Spec: docs/specs/004-tasks.md Phase 5.16 +
// docs/specs/004-xstate-agent-wrapper.md §Mapping +
// docs/specs/011-self-suspending-modes.md §Desugaring.
//
// SPEC 011 adaptations applied throughout (observable behaviour preserved):
//   - `ModeOutput` → `ModeResult`; the `retry` route is gone.
//   - There are no passive `{ on: { ... } }` leaves. An old passive transition
//     (`on: { MESSAGE: { target, actions } }`) becomes an EVENT-MODE whose
//     behavior runs on the event and whose `routes.achieved.assign` does what
//     the named action did. A terminal `{ on: {} }` sink becomes an event-mode
//     awaiting no events (parks forever).
//   - Every leaf lowers to a mini-compound, so raw `snapshot.value` is nested
//     (`{ done: "$wait" }`); `modeOf` reads the top-level mode name.
//   - An event-mode runs an ASYNC behavior (vs. the old synchronous passive
//     transition), so tests that send an event now `await settle()` before
//     asserting — same observable result, just the model's real async timing.

import { createActor } from "xstate";
import { describe, expect, test } from "vitest";

import { defineAgent } from "../src/defineAgent.ts";
import { defineMode } from "../src/defineMode.ts";
import { defineCompoundMode } from "../src/defineCompoundMode.ts";
import { END, RE_THROW } from "../src/types.ts";
import type { ModeResult } from "../src/types.ts";

type Ctx = { readonly messages: readonly string[]; readonly turns: number };
type Events = { type: "MESSAGE"; text: string };

// ── Helpers ─────────────────────────────────────────────────────────

function startedActor(machine: ReturnType<typeof defineAgent>) {
    const actor = createActor(machine);
    actor.start();
    return actor;
}

// Drain microtasks so async `behavior` promises and the resulting transitions
// land before we read state. SPEC 011: every leaf runs an async behavior (no
// synchronous passive transitions anymore), so a multi-hop chain — e.g.
// listening → classifying → greetings.thinking → END → listening — needs more
// microtask rounds than the pre-011 (partly synchronous) flow did.
async function settle(): Promise<void> {
    for (let i = 0; i < 40; i += 1) {
        await new Promise<void>((r) => queueMicrotask(r));
    }
}

// SPEC 011: a leaf is a mini-compound, so `snapshot.value` is nested
// (`{ done: "$wait" }`) rather than the flat `"done"` it was. Read the
// top-level mode name. (Compiles to the same mode-level assertion as before.)
const modeOf = (value: unknown): string =>
    typeof value === "string" ? value : Object.keys(value as object)[0];

// SPEC 011: terminal sink — an event-mode awaiting no events parks forever; its
// `routes` (self-target) are unreachable scaffolding. Replaces the old `{ on: {} }`.
const sink = <C>(self: string) =>
    defineMode<C, Events>({
        start: "event",
        events: [],
        input: () => null,
        behavior: async () => ({ outcome: "achieved", payload: undefined }),
        routes: { achieved: { target: self }, abandoned: { target: self } },
    });

describe("compile() — single active leaf agent", () => {
    test("compiles, starts, transitions via achieved payload route", async () => {
        const classifying = defineMode<Ctx, Events, { intent: "greeting" | "general" }>({
            input: ({ context }) => context.messages,
            behavior: async () =>
                ({ outcome: "achieved", payload: { intent: "greeting" } } satisfies ModeResult<{
                    intent: "greeting" | "general";
                }>),
            routes: {
                achieved: [
                    { when: (p) => p.intent === "greeting", target: "done" },
                    { target: "done" },
                ],
                abandoned: { target: "done" },
            },
        });
        const done = sink<Ctx>("done");

        const machine = defineAgent<Ctx, Events, { classifying: typeof classifying; done: typeof done }>({
            id: "agent",
            initial: "classifying",
            context: { messages: ["hi"], turns: 0 },
            events: {} as Events,
            modes: { classifying, done },
        });

        const actor = startedActor(machine);
        await settle();
        expect(modeOf(actor.getSnapshot().value)).toBe("done");
    });
});

describe("compile() — event-mode leaf agent", () => {
    test("event triggers the behavior, whose achieved route appends + transitions", async () => {
        // SPEC 011: the old passive `on: { MESSAGE: { target: "echo", actions:
        // "appendMessage" } }` becomes an event-mode — the behavior runs on
        // MESSAGE and the achieved route's `assign` does the append.
        const listening = defineMode<Ctx, Events, { text: string }>({
            start: "event",
            events: ["MESSAGE"],
            input: ({ context }) => context.messages,
            behavior: async ({ event }) => ({ outcome: "achieved", payload: { text: event.text } }),
            routes: {
                achieved: {
                    target: "echo",
                    assign: ({ context, payload }) => ({ messages: [...context.messages, payload.text] }),
                },
                abandoned: { target: "echo" },
            },
        });
        const echo = sink<Ctx>("echo");

        const machine = defineAgent<Ctx, Events, { listening: typeof listening; echo: typeof echo }>({
            id: "agent",
            initial: "listening",
            context: { messages: [], turns: 0 },
            events: {} as Events,
            modes: { listening, echo },
        });

        const actor = startedActor(machine);
        actor.send({ type: "MESSAGE", text: "hello" });
        await settle(); // event-mode behavior is async (was a sync passive transition)
        const snap = actor.getSnapshot();
        expect(modeOf(snap.value)).toBe("echo");
        expect((snap.context as Ctx).messages).toEqual(["hello"]);
    });
});

describe("compile() — compound with END exits", () => {
    test("injects $end + compound onDone fires", async () => {
        const inner = defineMode<Ctx, Events>({
            input: ({ context }) => context.messages,
            behavior: async () =>
                ({ outcome: "achieved", payload: undefined } satisfies ModeResult<undefined>),
            routes: {
                achieved: { target: END },
                abandoned: { target: END },
            },
        });
        const group = defineCompoundMode<Ctx, Events, undefined, { inner: typeof inner }>({
            initial: "inner",
            modes: { inner },
            routes: {
                achieved: { target: "done" },
                abandoned: { target: "done" },
            },
        });
        const done = sink<Ctx>("done");

        const machine = defineAgent<Ctx, Events, { group: typeof group; done: typeof done }>({
            id: "agent",
            initial: "group",
            context: { messages: [], turns: 0 },
            events: {} as Events,
            modes: { group, done },
        });

        const actor = startedActor(machine);
        await settle();
        expect(modeOf(actor.getSnapshot().value)).toBe("done");
    });
});

describe("compile() — END-free compound (5.12)", () => {
    test("no `$end` substate is injected when no child targets END", () => {
        // SPEC 011: `a` is an event-mode (was passive `on: { MESSAGE → b }`); it
        // parks in `$wait` on entry. No child targets END, so `compile.ts`
        // injects no compound-level `$end` for `group` — the active value never
        // contains `$end` (the leaves' own inactive `$end_*` finals don't show).
        const a = defineMode<Ctx, Events, undefined>({
            start: "event",
            events: ["MESSAGE"],
            input: ({ context }) => context.messages,
            behavior: async () => ({ outcome: "achieved", payload: undefined }),
            routes: {
                achieved: { target: "b" },
                abandoned: { target: "b" },
            },
        });
        const b = sink<Ctx>("b");
        const group = defineCompoundMode<Ctx, Events, undefined, { a: typeof a; b: typeof b }>({
            initial: "a",
            modes: { a, b },
            // Not reachable; the compound never finalises. Required for shape.
            routes: {
                achieved: { target: "other" },
                abandoned: { target: "other" },
            },
        });
        const other = sink<Ctx>("other");

        const machine = defineAgent<Ctx, Events, { group: typeof group; other: typeof other }>({
            id: "agent",
            initial: "group",
            context: { messages: [], turns: 0 },
            events: {} as Events,
            modes: { group, other },
        });

        const snap = createActor(machine).start().getSnapshot();
        expect(JSON.stringify(snap.value)).not.toContain("$end");
    });
});

describe("compile() — compound with local context", () => {
    test("entry assigns local slot; child sees inherited + local view", async () => {
        type Local = { attempts: number };
        type CtxLocal = { messages: readonly string[] };

        const inner = defineMode<{ messages: readonly string[]; attempts: number }, Events, undefined>({
            input: ({ context }) => ({ a: context.attempts, m: context.messages.length }),
            behavior: async ({ input }) => {
                const i = input as { a: number; m: number };
                if (i.a < 0 || i.m < 0) throw new Error("bad");
                return { outcome: "achieved", payload: undefined } satisfies ModeResult<undefined>;
            },
            routes: {
                achieved: { target: END },
                abandoned: { target: END },
            },
        });

        const group = defineCompoundMode<
            CtxLocal,
            Events,
            { inherit: readonly ["messages"]; local: Local },
            { inner: typeof inner }
        >({
            context: { inherit: ["messages"] as const, local: { attempts: 0 } },
            initial: "inner",
            modes: { inner },
            routes: {
                achieved: { target: "done" },
                abandoned: { target: "done" },
            },
        });
        const done = sink<CtxLocal>("done");

        const machine = defineAgent<CtxLocal, Events, { group: typeof group; done: typeof done }>({
            id: "agent",
            initial: "group",
            context: { messages: ["hi"] },
            events: {} as Events,
            modes: { group, done },
        });

        const actor = startedActor(machine);
        // Once entered, the compound's `entry` action allocates the local slot
        // in the root context — assert by reading the context.
        const slotKey = "__group_local";
        const snapAfterEntry = actor.getSnapshot();
        expect(
            (snapAfterEntry.context as Record<string, unknown>)[slotKey],
        ).toEqual({ attempts: 0 });

        await settle();
        // After inner achieves END → compound's onDone → "done". The exit action
        // cleared the local slot back to undefined.
        const final = actor.getSnapshot();
        expect(modeOf(final.value)).toBe("done");
        expect(
            (final.context as Record<string, unknown>)[slotKey],
        ).toBeUndefined();
    });
});

describe("compile() — RE_THROW error route", () => {
    test("rethrow propagates as actor error", async () => {
        const failing = defineMode<Ctx, Events, undefined>({
            input: ({ context }) => context.messages,
            behavior: async () => {
                throw new TypeError("programmer error");
            },
            routes: {
                achieved: { target: "done" },
                abandoned: { target: "done" },
                error: [
                    { when: (e) => e instanceof TypeError, target: RE_THROW },
                    { target: "done" },
                ],
            },
        });
        const done = sink<Ctx>("done");

        const machine = defineAgent<Ctx, Events, { failing: typeof failing; done: typeof done }>({
            id: "agent",
            initial: "failing",
            context: { messages: [], turns: 0 },
            events: {} as Events,
            modes: { failing, done },
        });

        // Hand-rolled subscribe — wait for the actor to surface the error.
        const errors: unknown[] = [];
        const actor = createActor(machine);
        actor.subscribe({ error: (e) => errors.push(e) });
        actor.start();
        await settle();

        expect(errors.length).toBeGreaterThan(0);
        expect(errors[0]).toBeInstanceOf(TypeError);
    });
});

describe("compile() — validator integration (fail-fast)", () => {
    test("validateTargets fires on machine creation for unknown sibling", () => {
        const bad = defineMode<Ctx, Events>({
            input: ({ context }) => context.messages,
            behavior: async () =>
                ({ outcome: "achieved", payload: undefined } satisfies ModeResult<undefined>),
            routes: {
                achieved: { target: "nonexistent" },
                abandoned: { target: END },
            },
        });

        expect(() =>
            defineAgent<Ctx, Events, { bad: typeof bad }>({
                id: "agent",
                initial: "bad",
                context: { messages: [], turns: 0 },
                events: {} as Events,
                modes: { bad },
            }),
        ).toThrow(/no such sibling/);
    });

    test("validateRoutes fires on machine creation for `[]` on a required slot", () => {
        const carrier = {
            __kind: "leaf" as const,
            config: {
                input: () => undefined,
                behavior: async () => ({ outcome: "achieved" as const, payload: undefined }),
                routes: {
                    achieved: [] as unknown[], // bypass the type system
                    abandoned: { target: END },
                },
            },
        };

        expect(() =>
            defineAgent<Ctx, Events, { bad: ReturnType<typeof defineMode<Ctx, Events>> }>({
                id: "agent",
                initial: "bad",
                context: { messages: [], turns: 0 },
                events: {} as Events,
                modes: {
                    bad: carrier as unknown as ReturnType<typeof defineMode<Ctx, Events>>,
                },
            }),
        ).toThrow(/empty array/);
    });
});

describe("compile() — actor naming (DD-008 as invariant)", () => {
    test("leaf at `socratic.evaluating` registers `socraticEvaluatingNode`", () => {
        const evaluating = defineMode<Ctx, Events>({
            input: ({ context }) => context.messages,
            behavior: async () =>
                ({ outcome: "achieved", payload: undefined } satisfies ModeResult<undefined>),
            routes: {
                achieved: { target: END },
                abandoned: { target: END },
            },
        });
        const socratic = defineCompoundMode<Ctx, Events, undefined, { evaluating: typeof evaluating }>({
            initial: "evaluating",
            modes: { evaluating },
            routes: {
                achieved: { target: "done" },
                abandoned: { target: "done" },
            },
        });
        const done = sink<Ctx>("done");

        const machine = defineAgent<Ctx, Events, { socratic: typeof socratic; done: typeof done }>({
            id: "agent",
            initial: "socratic",
            context: { messages: [], turns: 0 },
            events: {} as Events,
            modes: { socratic, done },
        });

        // Reach into the machine's implementations to assert the actor key.
        // `machine.implementations.actors` is the resolved `setup({ actors })`
        // map — keyed by camelCased dotted path + `Node`.
        const actorKeys = Object.keys(
            (machine as unknown as { implementations: { actors: Record<string, unknown> } })
                .implementations.actors,
        );
        expect(actorKeys).toContain("socraticEvaluatingNode");
    });
});

describe("compile() — full smoke (representative machine)", () => {
    test("compiles a small but representative tree end-to-end", async () => {
        type SmokeCtx = { messages: readonly string[] };

        // SPEC 011: was passive `on: { MESSAGE: { target: "classifying", actions:
        // "appendMessage" } }`; now an event-mode whose achieved route appends.
        const listening = defineMode<SmokeCtx, Events, { text: string }>({
            start: "event",
            events: ["MESSAGE"],
            input: ({ context }) => context.messages,
            behavior: async ({ event }) => ({ outcome: "achieved", payload: { text: event.text } }),
            routes: {
                achieved: {
                    target: "classifying",
                    assign: ({ context, payload }) => ({ messages: [...context.messages, payload.text] }),
                },
                abandoned: { target: "classifying" },
            },
        });

        const classifying = defineMode<SmokeCtx, Events, { intent: "greet" | "other" }>({
            input: ({ context }) => context.messages,
            behavior: async ({ input }) => {
                const msgs = input as readonly string[];
                const last = msgs[msgs.length - 1] ?? "";
                return {
                    outcome: "achieved",
                    payload: { intent: last === "hi" ? "greet" : "other" },
                } satisfies ModeResult<{ intent: "greet" | "other" }>;
            },
            routes: {
                achieved: [
                    { when: (p) => p.intent === "greet", target: "greetings" },
                    { target: "listening" },
                ],
                abandoned: { target: "listening" },
            },
        });

        const greetingsThinking = defineMode<SmokeCtx, Events, undefined>({
            input: ({ context }) => context.messages,
            behavior: async () =>
                ({ outcome: "achieved", payload: undefined } satisfies ModeResult<undefined>),
            routes: {
                achieved: { target: END },
                abandoned: { target: END },
            },
        });
        const greetings = defineCompoundMode<
            SmokeCtx,
            Events,
            undefined,
            { thinking: typeof greetingsThinking }
        >({
            initial: "thinking",
            modes: { thinking: greetingsThinking },
            routes: {
                achieved: { target: "listening" },
                abandoned: { target: "listening" },
            },
        });

        const machine = defineAgent<
            SmokeCtx,
            Events,
            { listening: typeof listening; classifying: typeof classifying; greetings: typeof greetings }
        >({
            id: "agent",
            initial: "listening",
            context: { messages: [] },
            events: {} as Events,
            modes: { listening, classifying, greetings },
        });

        const actor = startedActor(machine);
        expect(modeOf(actor.getSnapshot().value)).toBe("listening");

        actor.send({ type: "MESSAGE", text: "hi" });
        await settle();
        // greet → enters `greetings` → thinking resolves → END → greetings.onDone → "listening"
        expect(modeOf(actor.getSnapshot().value)).toBe("listening");
        expect((actor.getSnapshot().context as SmokeCtx).messages).toEqual(["hi"]);
    });
});
