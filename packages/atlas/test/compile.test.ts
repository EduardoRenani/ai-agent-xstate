// Phase 5.16 runtime tests: final emit — `compile()` composes every slice
// (validators + walk + buildActors + buildActions + buildActiveState /
// buildPassiveState with parent lift + per-level END injection) and hands
// the result to `setup({...}).createMachine({...})`. `defineAgent` returns
// that machine verbatim.
//
// Spec: docs/specs/004-tasks.md Phase 5.16 +
// docs/specs/004-xstate-agent-wrapper.md §Mapping.

import { createActor } from "xstate";
import { describe, expect, test } from "vitest";

import { defineAgent } from "../src/defineAgent.ts";
import { defineLeafMode } from "../src/defineLeafMode.ts";
import { defineMode } from "../src/defineMode.ts";
import { END, RE_THROW } from "../src/types.ts";
import type { ModeOutput } from "../src/types.ts";

type Ctx = { readonly messages: readonly string[]; readonly turns: number };
type Events = { type: "MESSAGE"; text: string };

// ── Helpers ─────────────────────────────────────────────────────────

// `createActor(machine).start()` lets us inspect XState's runtime snapshot
// (state value, context) — the simplest way to assert the machine compiled
// to the right shape end-to-end.
function startedActor(machine: ReturnType<typeof defineAgent>) {
    const actor = createActor(machine);
    actor.start();
    return actor;
}

// Drain microtasks so async `behavior` promises and the resulting `onDone`
// transitions land before we read state.
async function settle(): Promise<void> {
    await new Promise<void>((r) => queueMicrotask(r));
    await new Promise<void>((r) => queueMicrotask(r));
    await new Promise<void>((r) => queueMicrotask(r));
}

describe("compile() — single active leaf agent", () => {
    test("compiles, starts, transitions via achieved payload route", async () => {
        const classifying = defineLeafMode<Ctx, Events, { intent: "greeting" | "general" }>({
            input: ({ context }) => context.messages,
            behavior: async () =>
                ({ outcome: "achieved", payload: { intent: "greeting" } } satisfies ModeOutput<{
                    intent: "greeting" | "general";
                }>),
            routes: {
                achieved: [
                    { when: (p) => p.intent === "greeting", target: "done" },
                    { target: "done" },
                ],
                retry: [],
                abandoned: { target: "done" },
            },
        });
        const done = defineLeafMode<Ctx, Events>({
            on: {},
        });

        const machine = defineAgent<Ctx, Events, { classifying: typeof classifying; done: typeof done }>({
            id: "agent",
            initial: "classifying",
            context: { messages: ["hi"], turns: 0 },
            events: {} as Events,
            modes: { classifying, done },
        });

        const actor = startedActor(machine);
        await settle();
        expect(actor.getSnapshot().value).toBe("done");
    });
});

describe("compile() — passive leaf agent", () => {
    test("event triggers transition with action", () => {
        const listening = defineLeafMode<Ctx, Events>({
            on: {
                MESSAGE: {
                    target: "echo",
                    actions: "appendMessage",
                },
            },
        });
        const echo = defineLeafMode<Ctx, Events>({ on: {} });

        const machine = defineAgent<Ctx, Events, { listening: typeof listening; echo: typeof echo }>({
            id: "agent",
            initial: "listening",
            context: { messages: [], turns: 0 },
            events: {} as Events,
            actions: {
                appendMessage: ({ context, event }) => {
                    const e = event as { type: "MESSAGE"; text: string };
                    return { messages: [...context.messages, e.text] };
                },
            },
            modes: { listening, echo },
        });

        const actor = startedActor(machine);
        actor.send({ type: "MESSAGE", text: "hello" });
        const snap = actor.getSnapshot();
        expect(snap.value).toBe("echo");
        expect((snap.context as Ctx).messages).toEqual(["hello"]);
    });
});

describe("compile() — compound with END exits", () => {
    test("injects $end + compound onDone fires", async () => {
        const inner = defineLeafMode<Ctx, Events>({
            input: ({ context }) => context.messages,
            behavior: async () =>
                ({ outcome: "achieved", payload: undefined } satisfies ModeOutput<undefined>),
            routes: {
                achieved: { target: END },
                retry: [],
                abandoned: { target: END },
            },
        });
        const group = defineMode<Ctx, Events, undefined, { inner: typeof inner }>({
            initial: "inner",
            modes: { inner },
            onDone: "done",
        });
        const done = defineLeafMode<Ctx, Events>({ on: {} });

        const machine = defineAgent<Ctx, Events, { group: typeof group; done: typeof done }>({
            id: "agent",
            initial: "group",
            context: { messages: [], turns: 0 },
            events: {} as Events,
            modes: { group, done },
        });

        const actor = startedActor(machine);
        await settle();
        expect(actor.getSnapshot().value).toBe("done");
    });
});

describe("compile() — END-free compound (5.12)", () => {
    test("no `$end` substate is injected when no child targets END", () => {
        const a = defineLeafMode<Ctx, Events>({
            on: { MESSAGE: { target: "b" } },
        });
        const b = defineLeafMode<Ctx, Events>({ on: {} });
        const group = defineMode<Ctx, Events, undefined, { a: typeof a; b: typeof b }>({
            initial: "a",
            modes: { a, b },
            onDone: "other", // not reachable; the compound never finalises
        });
        const other = defineLeafMode<Ctx, Events>({ on: {} });

        const machine = defineAgent<Ctx, Events, { group: typeof group; other: typeof other }>({
            id: "agent",
            initial: "group",
            context: { messages: [], turns: 0 },
            events: {} as Events,
            modes: { group, other },
        });

        // `getInitialSnapshot`'s value carries the nested-compound state name;
        // it must NOT contain `$end` anywhere.
        const snap = createActor(machine).start().getSnapshot();
        expect(JSON.stringify(snap.value)).not.toContain("$end");
    });
});

describe("compile() — compound with local context", () => {
    test("entry assigns local slot; child sees inherited + local view", async () => {
        type Local = { attempts: number };
        type CtxLocal = { messages: readonly string[] };

        const inner = defineLeafMode<{ messages: readonly string[]; attempts: number }, Events, undefined>({
            input: ({ context }) => ({ a: context.attempts, m: context.messages.length }),
            behavior: async ({ input }) => {
                const i = input as { a: number; m: number };
                if (i.a < 0 || i.m < 0) throw new Error("bad");
                return { outcome: "achieved", payload: undefined } satisfies ModeOutput<undefined>;
            },
            routes: {
                achieved: { target: END },
                retry: [],
                abandoned: { target: END },
            },
        });

        const group = defineMode<
            CtxLocal,
            Events,
            { inherit: readonly ["messages"]; local: Local },
            { inner: typeof inner }
        >({
            context: { inherit: ["messages"] as const, local: { attempts: 0 } },
            initial: "inner",
            modes: { inner },
            onDone: "done",
        });
        const done = defineLeafMode<CtxLocal, Events>({ on: {} });

        const machine = defineAgent<CtxLocal, Events, { group: typeof group; done: typeof done }>({
            id: "agent",
            initial: "group",
            context: { messages: ["hi"] },
            events: {} as Events,
            modes: { group, done },
        });

        const actor = startedActor(machine);
        // Once entered, the compound's `entry` action allocates the local
        // slot in the root context — assert by reading the context.
        const slotKey = "__group_local";
        const snapAfterEntry = actor.getSnapshot();
        expect(
            (snapAfterEntry.context as Record<string, unknown>)[slotKey],
        ).toEqual({ attempts: 0 });

        await settle();
        // After inner achieves END → compound's onDone → "done". exit action
        // cleared the local slot back to undefined.
        const final = actor.getSnapshot();
        expect(final.value).toBe("done");
        expect(
            (final.context as Record<string, unknown>)[slotKey],
        ).toBeUndefined();
    });
});

describe("compile() — RE_THROW error route", () => {
    test("rethrow propagates as actor error", async () => {
        const failing = defineLeafMode<Ctx, Events, undefined>({
            input: ({ context }) => context.messages,
            behavior: async () => {
                throw new TypeError("programmer error");
            },
            routes: {
                achieved: { target: "done" },
                retry: [],
                abandoned: { target: "done" },
                error: [
                    { when: (e) => e instanceof TypeError, target: RE_THROW },
                    { target: "done" },
                ],
            },
        });
        const done = defineLeafMode<Ctx, Events>({ on: {} });

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
        const bad = defineLeafMode<Ctx, Events>({
            input: ({ context }) => context.messages,
            behavior: async () =>
                ({ outcome: "achieved", payload: undefined } satisfies ModeOutput<undefined>),
            routes: {
                achieved: { target: "nonexistent" },
                retry: [],
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

    test("validateRoutes fires on machine creation for `[]` on a non-retry slot", () => {
        const carrier = {
            __kind: "leaf" as const,
            config: {
                input: () => undefined,
                behavior: async () => ({ outcome: "achieved" as const, payload: undefined }),
                routes: {
                    achieved: [] as unknown[], // bypass the type system
                    retry: [] as unknown[],
                    abandoned: { target: END },
                },
            },
        };

        expect(() =>
            defineAgent<Ctx, Events, { bad: ReturnType<typeof defineLeafMode<Ctx, Events>> }>({
                id: "agent",
                initial: "bad",
                context: { messages: [], turns: 0 },
                events: {} as Events,
                modes: {
                    bad: carrier as unknown as ReturnType<typeof defineLeafMode<Ctx, Events>>,
                },
            }),
        ).toThrow(/empty array/);
    });
});

describe("compile() — actor naming (DD-008 as invariant)", () => {
    test("leaf at `socratic.evaluating` registers `socraticEvaluatingNode`", () => {
        const evaluating = defineLeafMode<Ctx, Events>({
            input: ({ context }) => context.messages,
            behavior: async () =>
                ({ outcome: "achieved", payload: undefined } satisfies ModeOutput<undefined>),
            routes: {
                achieved: { target: END },
                retry: [],
                abandoned: { target: END },
            },
        });
        const socratic = defineMode<Ctx, Events, undefined, { evaluating: typeof evaluating }>({
            initial: "evaluating",
            modes: { evaluating },
            onDone: "done",
        });
        const done = defineLeafMode<Ctx, Events>({ on: {} });

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

        const listening = defineLeafMode<SmokeCtx, Events>({
            on: { MESSAGE: { target: "classifying", actions: "appendMessage" } },
        });

        const classifying = defineLeafMode<SmokeCtx, Events, { intent: "greet" | "other" }>({
            input: ({ context }) => context.messages,
            behavior: async ({ input }) => {
                const msgs = input as readonly string[];
                const last = msgs[msgs.length - 1] ?? "";
                return {
                    outcome: "achieved",
                    payload: { intent: last === "hi" ? "greet" : "other" },
                } satisfies ModeOutput<{ intent: "greet" | "other" }>;
            },
            routes: {
                achieved: [
                    { when: (p) => p.intent === "greet", target: "greetings" },
                    { target: "listening" },
                ],
                retry: [],
                abandoned: { target: "listening" },
            },
        });

        const greetingsThinking = defineLeafMode<SmokeCtx, Events, undefined>({
            input: ({ context }) => context.messages,
            behavior: async () =>
                ({ outcome: "achieved", payload: undefined } satisfies ModeOutput<undefined>),
            routes: {
                achieved: { target: END },
                retry: [],
                abandoned: { target: END },
            },
        });
        const greetings = defineMode<
            SmokeCtx,
            Events,
            undefined,
            { thinking: typeof greetingsThinking }
        >({
            initial: "thinking",
            modes: { thinking: greetingsThinking },
            onDone: "listening",
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
            actions: {
                appendMessage: ({ context, event }) => {
                    const e = event as { type: "MESSAGE"; text: string };
                    return { messages: [...context.messages, e.text] };
                },
            },
            modes: { listening, classifying, greetings },
        });

        const actor = startedActor(machine);
        expect(actor.getSnapshot().value).toBe("listening");

        actor.send({ type: "MESSAGE", text: "hi" });
        await settle();
        // greet → enters `greetings` → thinking resolves → END → greetings.onDone → "listening"
        expect(actor.getSnapshot().value).toBe("listening");
        expect((actor.getSnapshot().context as SmokeCtx).messages).toEqual(["hi"]);
    });
});
