// Spec 005 runtime tests for deps freezing, identity, and isolation.
// Spec §Imutabilidade + §Verification (runtime tests).

import { createActor, type AnyStateMachine } from "xstate";
import { describe, expect, test } from "vitest";

import { defineAgent } from "../src/defineAgent.ts";
import { defineMode } from "../src/defineMode.ts";
import type { Agent, ModeResult } from "../src/types.ts";

// SPEC 012 §Seam 1: `defineAgent` now returns the opaque `Agent` handle. These
// tests drive the compiled carrier through `createActor` directly to inspect
// lowering internals, so they unwrap `carrier` the way `startAgent` does.
function carrierOf<C, E extends { type: string }>(agent: Agent<C, E>): AnyStateMachine {
    return agent.carrier as AnyStateMachine;
}

type Ctx = { messages: readonly string[]; lastSeenBy: string };
type Events = { type: "MESSAGE"; text: string };

// SPEC 011: there is no more `{ on: {} }` passive leaf. A terminal sink — a mode
// the agent enters and never leaves — is an event-mode that awaits no events, so
// it parks in `$wait` forever; its behavior/routes are unreachable scaffolding.
// (Behaviorally identical to the old `{ on: {} }` sink for these tests, which
// only route INTO it after `probe` resolves and never leave.)
const terminalSink = () =>
    defineMode<Ctx, Events>({
        start: "event",
        events: [],
        input: () => null,
        behavior: async () => ({ outcome: "achieved", payload: undefined }),
        routes: { achieved: { target: "done" }, abandoned: { target: "done" } },
    });

describe("deps — construction-time freeze and identity", () => {
    test("`Object.freeze` is applied to the top level of the deps container", async () => {
        type Deps = { tag: string };
        let observedDeps: Readonly<Deps> | undefined;

        const probe = defineMode<Ctx, Events, undefined, Deps>({
            input: ({ deps }) => deps,
            behavior: async ({ deps }) => {
                observedDeps = deps;
                return { outcome: "achieved", payload: undefined } satisfies ModeResult<undefined>;
            },
            routes: {
                achieved: { target: "done" },
                abandoned: { target: "done" },
            },
        });
        const done = terminalSink();

        const machine = defineAgent<Ctx, Events, { probe: typeof probe; done: typeof done }, Deps>({
            id: "freeze",
            initial: "probe",
            context: { messages: [], lastSeenBy: "" },
            events: {} as Events,
            deps: { tag: "production" },
            modes: { probe, done },
        });

        const actor = createActor(carrierOf(machine)).start();
        await new Promise((r) => setTimeout(r, 0));
        actor.stop();

        expect(observedDeps).toBeDefined();
        expect(Object.isFrozen(observedDeps)).toBe(true);

        // Top-level reassignment throws under strict mode (test files run as
        // ES modules — strict by default).
        expect(() => {
            (observedDeps as { tag: string }).tag = "mutated";
        }).toThrow(TypeError);
    });

    test("mutating INSIDE a dep value is allowed (shallow freeze)", async () => {
        type NestedDep = { state: { calls: number } };
        let observed: Readonly<NestedDep> | undefined;

        const probe = defineMode<Ctx, Events, undefined, NestedDep>({
            input: ({ deps }) => deps,
            behavior: async ({ deps }) => {
                deps.state.calls += 1;
                observed = deps;
                return { outcome: "achieved", payload: undefined } satisfies ModeResult<undefined>;
            },
            routes: {
                achieved: { target: "done" },
                abandoned: { target: "done" },
            },
        });
        const done = terminalSink();

        const initialState = { calls: 0 };
        const machine = defineAgent<Ctx, Events, { probe: typeof probe; done: typeof done }, NestedDep>({
            id: "shallow",
            initial: "probe",
            context: { messages: [], lastSeenBy: "" },
            events: {} as Events,
            deps: { state: initialState },
            modes: { probe, done },
        });

        const actor = createActor(carrierOf(machine)).start();
        await new Promise((r) => setTimeout(r, 0));
        actor.stop();

        expect(observed?.state.calls).toBe(1);
        // Inner object is the SAME reference the consumer handed in — the
        // wrapper does not deep-freeze.
        expect(observed?.state).toBe(initialState);
        expect(Object.isFrozen(initialState)).toBe(false);
    });

    test("the deps reference seen by callbacks is identical across every callback site", async () => {
        type Deps = { id: string };
        const seenIn: Record<string, unknown> = {};

        const probe = defineMode<Ctx, Events, { value: number }, Deps>({
            input: ({ deps }) => {
                seenIn.input = deps;
                return null;
            },
            behavior: async ({ deps }) => {
                seenIn.behavior = deps;
                return { outcome: "achieved", payload: { value: 1 } } satisfies ModeResult<{ value: number }>;
            },
            routes: {
                achieved: {
                    target: "done",
                    assign: ({ context, payload, deps }) => {
                        seenIn.assign = deps;
                        return { lastSeenBy: `${context.lastSeenBy}|${payload.value}` };
                    },
                },
                abandoned: { target: "done" },
            },
        });
        const done = terminalSink();

        const depsValue: Deps = { id: "the-one" };
        const machine = defineAgent<Ctx, Events, { probe: typeof probe; done: typeof done }, Deps>({
            id: "identity",
            initial: "probe",
            context: { messages: [], lastSeenBy: "" },
            events: {} as Events,
            deps: depsValue,
            modes: { probe, done },
        });

        const actor = createActor(carrierOf(machine)).start();
        await new Promise((r) => setTimeout(r, 0));
        actor.stop();

        // Same reference — and it's the frozen wrapping of the user's input.
        expect(seenIn.input).toBe(seenIn.behavior);
        expect(seenIn.behavior).toBe(seenIn.assign);
        // The reference is the same object the consumer passed (frozen in place).
        expect(seenIn.input).toBe(depsValue);
    });

    test("two agents with different deps produce two machines with no cross-talk", async () => {
        type Deps = { id: string };
        const probeFor = (tagDest: { id?: string }) =>
            defineMode<Ctx, Events, undefined, Deps>({
                input: ({ deps }) => deps,
                behavior: async ({ deps }) => {
                    tagDest.id = deps.id;
                    return { outcome: "achieved", payload: undefined } satisfies ModeResult<undefined>;
                },
                routes: {
                    achieved: { target: "done" },
                    abandoned: { target: "done" },
                },
            });

        const aSeen: { id?: string } = {};
        const bSeen: { id?: string } = {};
        const aProbe = probeFor(aSeen);
        const bProbe = probeFor(bSeen);
        const done = terminalSink();

        const machineA = defineAgent<Ctx, Events, { probe: typeof aProbe; done: typeof done }, Deps>({
            id: "a",
            initial: "probe",
            context: { messages: [], lastSeenBy: "" },
            events: {} as Events,
            deps: { id: "A" },
            modes: { probe: aProbe, done },
        });
        const machineB = defineAgent<Ctx, Events, { probe: typeof bProbe; done: typeof done }, Deps>({
            id: "b",
            initial: "probe",
            context: { messages: [], lastSeenBy: "" },
            events: {} as Events,
            deps: { id: "B" },
            modes: { probe: bProbe, done },
        });

        const actorA = createActor(carrierOf(machineA)).start();
        const actorB = createActor(carrierOf(machineB)).start();
        await new Promise((r) => setTimeout(r, 0));
        actorA.stop();
        actorB.stop();

        expect(aSeen.id).toBe("A");
        expect(bSeen.id).toBe("B");
    });
});

describe("deps — defaulting to `{}` when omitted", () => {
    test("a consumer that omits `deps` sees a frozen `{}` in callbacks", async () => {
        let observed: unknown;
        const probe = defineMode<Ctx, Events, undefined>({
            input: ({ deps }) => deps,
            behavior: async ({ deps }) => {
                observed = deps;
                return { outcome: "achieved", payload: undefined } satisfies ModeResult<undefined>;
            },
            routes: {
                achieved: { target: "done" },
                abandoned: { target: "done" },
            },
        });
        const done = terminalSink();

        const machine = defineAgent<Ctx, Events, { probe: typeof probe; done: typeof done }>({
            id: "no-deps",
            initial: "probe",
            context: { messages: [], lastSeenBy: "" },
            events: {} as Events,
            // no `deps` — TDeps defaults to Record<string, never>
            modes: { probe, done },
        });

        const actor = createActor(carrierOf(machine)).start();
        await new Promise((r) => setTimeout(r, 0));
        actor.stop();

        expect(observed).toEqual({});
        expect(Object.isFrozen(observed)).toBe(true);
    });
});
