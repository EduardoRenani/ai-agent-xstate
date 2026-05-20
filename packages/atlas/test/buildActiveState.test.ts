// Phase 5.6 + 5.7 runtime tests: active leaf → `{ invoke: { src, input, onDone } }`,
// where each `onDone[i]` carries target, guard, and optional wrapped actions.
// Spec: docs/specs/004-tasks.md Phase 5.6 + 5.7.

import { createActor, setup, fromPromise } from "xstate";
import { describe, expect, test } from "vitest";

import { buildActiveState } from "../src/buildActiveState.ts";
import { defineLeafMode } from "../src/defineLeafMode.ts";
import { END, RE_THROW } from "../src/types.ts";
import type { ModeOutput } from "../src/types.ts";
import type { LeafSlot } from "../src/walk.ts";

type Ctx = { messages: readonly string[]; count: number };
type Events = { type: "MESSAGE"; text: string };
type P = { intent: "greeting" | "general" };

// Helper: take a `LeafMode` carrier and synthesize a LeafSlot at the given
// path so the test can exercise `buildActiveState` directly without going
// through the full walk.
function slotAt(
    path: string,
    leaf: ReturnType<typeof defineLeafMode<Ctx, Events, P>>,
): LeafSlot {
    const carrier = leaf as unknown as {
        __kind: "leaf";
        config: Parameters<typeof buildActiveState>[0]["config"];
    };
    return { kind: "leaf", path, config: carrier.config };
}

// Fake XState done event for guard probing — `event.output` is what XState
// passes when an invoked actor resolves.
function fakeDone(out: ModeOutput<unknown>) {
    return { event: { output: out } };
}

describe("buildActiveState() — structure & ordering (5.6)", () => {
    test("single-entry routes: onDone = [achieved, retry, abandoned] in that order", () => {
        const inputFn = ({ context }: { context: Ctx }) => context.messages;
        const leaf = defineLeafMode<Ctx, Events, P>({
            input: inputFn,
            behavior: async () => ({ outcome: "achieved", payload: { intent: "greeting" } } satisfies ModeOutput<P>),
            routes: {
                achieved: { target: "greetings" },
                retry: {},
                abandoned: { target: "listening" },
            },
        });

        const lowered = buildActiveState(slotAt("classifying", leaf));
        expect(lowered.invoke.src).toBe("classifyingNode");
        expect(lowered.invoke.input).toBe(inputFn);
        expect(lowered.invoke.onDone).toMatchObject([
            { target: "greetings" },
            { target: "classifying", reenter: true },
            { target: "listening" },
        ]);
    });

    test("RouteList form: each entry produces one onDone transition, in array order", () => {
        const leaf = defineLeafMode<Ctx, Events, P>({
            input: ({ context }) => context.messages,
            behavior: async () => ({ outcome: "achieved", payload: { intent: "greeting" } } satisfies ModeOutput<P>),
            routes: {
                achieved: [
                    { when: (p) => p.intent === "greeting", target: "greetings" },
                    { target: "improvising" },
                ],
                retry: [
                    { when: (p) => p.intent === "general" },
                    {},
                ],
                abandoned: [
                    { when: (p) => p.intent === "general", target: "listening" },
                    { target: END },
                ],
            },
        });

        const lowered = buildActiveState(slotAt("classifying", leaf));
        expect(lowered.invoke.onDone).toMatchObject([
            { target: "greetings" },
            { target: "improvising" },
            { target: "classifying", reenter: true },
            { target: "classifying", reenter: true },
            { target: "listening" },
            { target: END },
        ]);
    });

    test("`retry: []` (no special handling) produces zero retry onDone entries", () => {
        const leaf = defineLeafMode<Ctx, Events, P>({
            input: ({ context }) => context.messages,
            behavior: async () => ({ outcome: "achieved", payload: { intent: "greeting" } } satisfies ModeOutput<P>),
            routes: {
                achieved: { target: "next" },
                retry: [] as const,
                abandoned: { target: "fallback" },
            },
        });

        const lowered = buildActiveState(slotAt("classifying", leaf));
        expect(lowered.invoke.onDone).toMatchObject([
            { target: "next" },
            { target: "fallback" },
        ]);
    });

    test("nested leaf path: retry self-loop uses the last segment, not the dotted path", () => {
        const leaf = defineLeafMode<Ctx, Events, P>({
            input: ({ context }) => context.messages,
            behavior: async () => ({ outcome: "achieved", payload: { intent: "greeting" } } satisfies ModeOutput<P>),
            routes: {
                achieved: { target: "teaching" },
                retry: {},
                abandoned: { target: "teaching" },
            },
        });

        const lowered = buildActiveState(slotAt("socratic.evaluating", leaf));
        expect(lowered.invoke.src).toBe("socraticEvaluatingNode");
        expect(lowered.invoke.onDone[1]).toMatchObject({
            target: "evaluating",
            reenter: true,
        });
    });

    test("rejects a passive leaf slot", () => {
        const leaf = defineLeafMode<Ctx, Events>({
            on: { MESSAGE: { target: "classifying" } },
        });
        const carrier = leaf as unknown as { __kind: "leaf"; config: unknown };
        const slot: LeafSlot = {
            kind: "leaf",
            path: "listening",
            config: carrier.config as Parameters<typeof buildActiveState>[0]["config"],
        };
        expect(() => buildActiveState(slot)).toThrow(/passive/);
    });
});

describe("buildActiveState() — guards (5.7)", () => {
    test("entry-default guard: outcome match only, no `when`", () => {
        const leaf = defineLeafMode<Ctx, Events, P>({
            input: ({ context }) => context.messages,
            behavior: async () => ({ outcome: "achieved", payload: { intent: "greeting" } } satisfies ModeOutput<P>),
            routes: {
                achieved: { target: "next" },          // no `when`
                retry: {},                              // no `when`
                abandoned: { target: "fallback" },     // no `when`
            },
        });

        const lowered = buildActiveState(slotAt("classifying", leaf));
        const [achievedT, retryT, abandonedT] = lowered.invoke.onDone;

        // achieved guard fires only on outcome === "achieved"
        expect(achievedT?.guard?.(fakeDone({ outcome: "achieved", payload: { intent: "greeting" } }))).toBe(true);
        expect(achievedT?.guard?.(fakeDone({ outcome: "retry", payload: { intent: "greeting" } }))).toBe(false);
        expect(achievedT?.guard?.(fakeDone({ outcome: "abandoned", payload: { intent: "greeting" } }))).toBe(false);

        // retry guard fires only on outcome === "retry"
        expect(retryT?.guard?.(fakeDone({ outcome: "retry", payload: { intent: "greeting" } }))).toBe(true);
        expect(retryT?.guard?.(fakeDone({ outcome: "achieved", payload: { intent: "greeting" } }))).toBe(false);

        // abandoned guard fires only on outcome === "abandoned"
        expect(abandonedT?.guard?.(fakeDone({ outcome: "abandoned", payload: { intent: "greeting" } }))).toBe(true);
        expect(abandonedT?.guard?.(fakeDone({ outcome: "achieved", payload: { intent: "greeting" } }))).toBe(false);
    });

    test("guard combines outcome check AND user's `when(payload)` (first match wins encoding)", () => {
        const leaf = defineLeafMode<Ctx, Events, P>({
            input: ({ context }) => context.messages,
            behavior: async () => ({ outcome: "achieved", payload: { intent: "greeting" } } satisfies ModeOutput<P>),
            routes: {
                achieved: [
                    { when: (p) => p.intent === "greeting", target: "greetings" },
                    { target: "improvising" },
                ],
                retry: {},
                abandoned: { target: "fallback" },
            },
        });

        const lowered = buildActiveState(slotAt("classifying", leaf));
        const [guarded, fallback] = lowered.invoke.onDone;

        // guarded entry fires only when outcome === "achieved" AND payload.intent === "greeting"
        expect(guarded?.guard?.(fakeDone({ outcome: "achieved", payload: { intent: "greeting" } }))).toBe(true);
        expect(guarded?.guard?.(fakeDone({ outcome: "achieved", payload: { intent: "general" } }))).toBe(false);
        expect(guarded?.guard?.(fakeDone({ outcome: "retry", payload: { intent: "greeting" } }))).toBe(false);

        // default (no `when`) — fires for any outcome === "achieved"
        expect(fallback?.guard?.(fakeDone({ outcome: "achieved", payload: { intent: "general" } }))).toBe(true);
        expect(fallback?.guard?.(fakeDone({ outcome: "achieved", payload: { intent: "greeting" } }))).toBe(true);
        expect(fallback?.guard?.(fakeDone({ outcome: "abandoned", payload: { intent: "general" } }))).toBe(false);
    });
});

describe("buildActiveState() — assign wrapping (5.7)", () => {
    test("user's `assign({ context, payload })` is applied to context via XState's assign(...)", async () => {
        // A leaf whose achieved route bumps `count` by 1 and appends a fixed
        // marker to `messages`. Run it through a real XState machine and
        // assert the context update.
        type LocalP = { value: number };

        const leaf = defineLeafMode<Ctx, Events, LocalP>({
            input: ({ context }) => context.messages,
            behavior: async () => ({ outcome: "achieved", payload: { value: 7 } } satisfies ModeOutput<LocalP>),
            routes: {
                achieved: {
                    target: "done",
                    assign: ({ context, payload }) => ({
                        count: context.count + payload.value,
                        messages: [...context.messages, `value=${payload.value}`],
                    }),
                },
                retry: {},
                abandoned: { target: "done" },
            },
        });

        const lowered = buildActiveState(slotAt("classifying", leaf));

        const machine = setup({
            types: {} as { context: Ctx; events: Events },
            actors: {
                classifyingNode: fromPromise(async () =>
                    ({ outcome: "achieved", payload: { value: 7 } } satisfies ModeOutput<LocalP>),
                ),
            },
        }).createMachine({
            id: "test",
            initial: "classifying",
            context: { messages: ["hi"], count: 1 },
            states: {
                classifying: lowered,
                done: { type: "final" },
            },
        });

        const actor = createActor(machine);
        actor.start();

        await new Promise<void>((resolve) => {
            actor.subscribe((snap) => {
                if (snap.status === "done") resolve();
            });
        });

        expect(actor.getSnapshot().context).toEqual({
            messages: ["hi", "value=7"],
            count: 8,
        });
    });

    test("missing `assign` → no `actions` field on the transition", () => {
        const leaf = defineLeafMode<Ctx, Events, P>({
            input: ({ context }) => context.messages,
            behavior: async () => ({ outcome: "achieved", payload: { intent: "greeting" } } satisfies ModeOutput<P>),
            routes: {
                achieved: { target: "next" },          // no assign
                retry: {},                              // no assign
                abandoned: { target: "fallback" },     // no assign
            },
        });

        const lowered = buildActiveState(slotAt("classifying", leaf));
        for (const t of lowered.invoke.onDone) {
            expect(t.actions).toBeUndefined();
        }
    });
});

describe("buildActiveState() — error routes → onError (5.9)", () => {
    function fakeErr(error: unknown) {
        return { event: { error } };
    }

    test("`routes.error` omitted → no `onError` field on the lowered invoke", () => {
        const leaf = defineLeafMode<Ctx, Events, P>({
            input: ({ context }) => context.messages,
            behavior: async () => ({ outcome: "achieved", payload: { intent: "greeting" } } satisfies ModeOutput<P>),
            routes: {
                achieved: { target: "next" },
                retry: {},
                abandoned: { target: "fallback" },
            },
        });
        const lowered = buildActiveState(slotAt("classifying", leaf));
        expect(lowered.invoke.onError).toBeUndefined();
    });

    test("single ErrorEntry → onError[0] with default-true guard, target preserved", () => {
        const leaf = defineLeafMode<Ctx, Events, P>({
            input: ({ context }) => context.messages,
            behavior: async () => ({ outcome: "achieved", payload: { intent: "greeting" } } satisfies ModeOutput<P>),
            routes: {
                achieved: { target: "next" },
                retry: {},
                abandoned: { target: "fallback" },
                error: { target: "errorState" },
            },
        });
        const lowered = buildActiveState(slotAt("classifying", leaf));
        expect(lowered.invoke.onError).toMatchObject([{ target: "errorState" }]);
        const [t] = lowered.invoke.onError ?? [];
        // No `when` → fires for any error.
        expect(t?.guard?.(fakeErr(new Error("boom")))).toBe(true);
        expect(t?.guard?.(fakeErr("string-error"))).toBe(true);
    });

    test("RouteList: `when(error)` filters; default fires when nothing else matches", () => {
        const leaf = defineLeafMode<Ctx, Events, P>({
            input: ({ context }) => context.messages,
            behavior: async () => ({ outcome: "achieved", payload: { intent: "greeting" } } satisfies ModeOutput<P>),
            routes: {
                achieved: { target: "next" },
                retry: {},
                abandoned: { target: "fallback" },
                error: [
                    { when: (e) => e instanceof TypeError, target: "typeErrorState" },
                    { target: "errorState" },
                ],
            },
        });
        const lowered = buildActiveState(slotAt("classifying", leaf));
        expect(lowered.invoke.onError).toHaveLength(2);

        const [guarded, defaultEntry] = lowered.invoke.onError ?? [];

        // guarded entry only fires for TypeError
        expect(guarded?.guard?.(fakeErr(new TypeError("nope")))).toBe(true);
        expect(guarded?.guard?.(fakeErr(new Error("normal")))).toBe(false);
        expect(guarded?.target).toBe("typeErrorState");

        // default entry fires for any error
        expect(defaultEntry?.guard?.(fakeErr(new Error("normal")))).toBe(true);
        expect(defaultEntry?.guard?.(fakeErr(new TypeError("nope")))).toBe(true);
        expect(defaultEntry?.target).toBe("errorState");
    });

    test("error `assign({ context, error })` is applied to context end-to-end", async () => {
        const boom = new Error("kaboom");

        const leaf = defineLeafMode<Ctx, Events, P>({
            input: ({ context }) => context.messages,
            behavior: async () => {
                throw boom;
            },
            routes: {
                achieved: { target: "done" },
                retry: {},
                abandoned: { target: "done" },
                error: {
                    target: "done",
                    assign: ({ context, error }) => ({
                        messages: [
                            ...context.messages,
                            `err:${error instanceof Error ? error.message : String(error)}`,
                        ],
                        count: context.count + 1,
                    }),
                },
            },
        });

        const lowered = buildActiveState(slotAt("classifying", leaf));

        const machine = setup({
            types: {} as { context: Ctx; events: Events },
            actors: {
                classifyingNode: fromPromise<ModeOutput<P>>(async () => {
                    throw boom;
                }),
            },
        }).createMachine({
            id: "test",
            initial: "classifying",
            context: { messages: ["hi"], count: 1 },
            states: {
                classifying: lowered,
                done: { type: "final" },
            },
        });

        const actor = createActor(machine);
        actor.start();

        await new Promise<void>((resolve) => {
            actor.subscribe((snap) => {
                if (snap.status === "done") resolve();
            });
        });

        expect(actor.getSnapshot().context).toEqual({
            messages: ["hi", "err:kaboom"],
            count: 2,
        });
    });

});

describe("buildActiveState() — RE_THROW (5.10)", () => {
    function fakeErr(error: unknown) {
        return { event: { error } };
    }

    test("`target: RE_THROW` produces a transition with no target and a re-throw action", () => {
        const leaf = defineLeafMode<Ctx, Events, P>({
            input: ({ context }) => context.messages,
            behavior: async () => ({ outcome: "achieved", payload: { intent: "greeting" } } satisfies ModeOutput<P>),
            routes: {
                achieved: { target: "next" },
                retry: {},
                abandoned: { target: "fallback" },
                error: { target: RE_THROW },
            },
        });
        const lowered = buildActiveState(slotAt("classifying", leaf));
        const t = lowered.invoke.onError?.[0];
        expect(t).toBeDefined();
        expect(t?.target).toBeUndefined();           // RE_THROW erases target
        expect(typeof t?.actions).toBe("function");   // a plain function, not assign()
    });

    test("the re-throw action throws the captured rejection when invoked", () => {
        const leaf = defineLeafMode<Ctx, Events, P>({
            input: ({ context }) => context.messages,
            behavior: async () => ({ outcome: "achieved", payload: { intent: "greeting" } } satisfies ModeOutput<P>),
            routes: {
                achieved: { target: "next" },
                retry: {},
                abandoned: { target: "fallback" },
                error: { target: RE_THROW },
            },
        });
        const lowered = buildActiveState(slotAt("classifying", leaf));
        const action = lowered.invoke.onError?.[0]?.actions;
        if (typeof action !== "function") {
            throw new Error("expected re-throw action to be a plain function");
        }
        const boom = new TypeError("kaboom");
        expect(() => action({ event: { error: boom } })).toThrow(boom);
    });

    test("RE_THROW preserves the user's `when` filter — guard still fires conditionally", () => {
        const leaf = defineLeafMode<Ctx, Events, P>({
            input: ({ context }) => context.messages,
            behavior: async () => ({ outcome: "achieved", payload: { intent: "greeting" } } satisfies ModeOutput<P>),
            routes: {
                achieved: { target: "next" },
                retry: {},
                abandoned: { target: "fallback" },
                error: [
                    { when: (e) => e instanceof TypeError, target: RE_THROW },
                    { target: "errorState" },
                ],
            },
        });
        const lowered = buildActiveState(slotAt("classifying", leaf));
        const [rethrowEntry, fallback] = lowered.invoke.onError ?? [];

        // RE_THROW entry's guard still filters by user's `when`.
        expect(rethrowEntry?.guard?.(fakeErr(new TypeError("yes")))).toBe(true);
        expect(rethrowEntry?.guard?.(fakeErr(new Error("no")))).toBe(false);
        expect(rethrowEntry?.target).toBeUndefined();
        expect(typeof rethrowEntry?.actions).toBe("function");

        // Fallback is untouched.
        expect(fallback?.target).toBe("errorState");
    });

    test("`assign` on a RE_THROW entry is dropped at compile time", () => {
        // The user's `assign` is supplied but must be ignored — RE_THROW's
        // only side effect is the re-throw.
        let assignCalled = false;
        const leaf = defineLeafMode<Ctx, Events, P>({
            input: ({ context }) => context.messages,
            behavior: async () => ({ outcome: "achieved", payload: { intent: "greeting" } } satisfies ModeOutput<P>),
            routes: {
                achieved: { target: "next" },
                retry: {},
                abandoned: { target: "fallback" },
                error: {
                    target: RE_THROW,
                    assign: ({ context }) => {
                        assignCalled = true;
                        return { count: context.count + 1 };
                    },
                },
            },
        });
        const lowered = buildActiveState(slotAt("classifying", leaf));
        const action = lowered.invoke.onError?.[0]?.actions;
        // Action is the bare re-throw, NOT the wrapped assign. Calling it
        // throws — it does not invoke the user's assign.
        if (typeof action !== "function") {
            throw new Error("expected re-throw action to be a plain function");
        }
        expect(() => action({ event: { error: new Error("x") } })).toThrow();
        expect(assignCalled).toBe(false);
    });
});
