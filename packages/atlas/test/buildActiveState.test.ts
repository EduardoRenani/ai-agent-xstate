// SPEC 011 §Desugaring: a leaf mode lowers to a **mini-compound**, not a bare
// `{ invoke }` leaf. `buildActiveState` returns:
//
//   { initial: "$run" | "$wait",
//     entry: <clear $event slot>,
//     states: { $run: { invoke: { src, input, onDone, onError? } },
//               $wait: { on, meta }, $end_achieved, $end_abandoned[, $end_error] },
//     onDone: [ <exit transitions: route targets + assigns> ] }
//
// Two levels now carry what the old single `onDone` did:
//   - `$run.invoke.onDone` DISPATCHES the behavior's result: outcome-only guards
//     route achieved/abandoned to the local `$end_*` finals; `stay:"replay"`
//     self-loops to `$run` (reenter); `stay:"waitOnEvent"` parks at `$wait`.
//   - `foo.onDone` (the compound's own `onDone`) carries the user's ROUTE
//     TARGETS + payload-`when` guards + exit `assign`s — exactly like a compound.
//   - `$run.invoke.onError` filters errors (by `when`) to the local `$end_error`
//     final, or re-throws (`RE_THROW`); the user's error target/assign live on
//     `foo.onDone`.
//
// These tests pin that structure (white-box, like the pre-011 suite which
// asserted bucket sentinels). The pre-011 single-leaf `{ invoke }` shape and the
// `retry` route are gone; `retry: {}` self-loops are now `stay:{ replay }`.

import { createActor, setup, fromPromise } from "xstate";
import { describe, expect, test } from "vitest";

import { buildActiveState } from "../src/buildActiveState.ts";
import type { LoweredInvokeState, LoweredWaitState } from "../src/buildActiveState.ts";
import { defineMode } from "../src/defineMode.ts";
import { END, RE_THROW } from "../src/types.ts";
import { END_ABANDONED } from "../src/endBuckets.ts";
import type { Mode, ModeResult, Outcome, Stay } from "../src/types.ts";
import type { LeafSlot } from "../src/walk.ts";

type Ctx = { messages: readonly string[]; count: number };
type Events = { type: "MESSAGE"; text: string };
type P = { intent: "greeting" | "general" };

// Helper: take a `Mode` carrier and synthesize a LeafSlot at the given path so
// the test can exercise `buildActiveState` directly without the full walk.
function slotAt(path: string, leaf: Mode<Ctx, Events, unknown>): LeafSlot {
    const carrier = leaf as unknown as {
        __kind: "leaf";
        config: Parameters<typeof buildActiveState>[0]["config"];
    };
    return { kind: "leaf", path, config: carrier.config };
}

// SPEC 011: the invoke now lives at `lowered.states.$run.invoke`. These reach it
// (and `$wait`) with the exported lowered types, no `any`.
const runOf = (l: ReturnType<typeof buildActiveState>): LoweredInvokeState["invoke"] =>
    (l.states.$run as LoweredInvokeState).invoke;
const waitOf = (l: ReturnType<typeof buildActiveState>): LoweredWaitState =>
    l.states.$wait as LoweredWaitState;

// Fake XState done event for guard probing — `event.output` carries the
// behavior's `ModeResult` (`{ outcome, payload }` XOR `{ stay, payload }`).
function fakeDone(out: { outcome?: Outcome; stay?: Stay; payload: unknown }) {
    return { event: { output: out } };
}
// Fake XState error event — `event.error` is the raw rejection.
function fakeErr(error: unknown) {
    return { event: { error } };
}

describe("buildActiveState() — structure & ordering (5.6)", () => {
    test("run mode lowers to a mini-compound: initial $run, $run/$wait/$end_* substates, slot-clearing entry", () => {
        const inputFn = ({ context }: { context: Ctx }) => context.messages;
        const leaf = defineMode<Ctx, Events, P>({
            input: inputFn,
            behavior: async () => ({ outcome: "achieved", payload: { intent: "greeting" } } satisfies ModeResult<P>),
            routes: {
                achieved: { target: "greetings" },
                abandoned: { target: "listening" },
            },
        });

        const lowered = buildActiveState(slotAt("classifying", leaf), undefined, {});
        // Run mode (no `start`) enters running.
        expect(lowered.initial).toBe("$run");
        // A direct entry clears the `$event` slot (assign action present).
        expect(lowered.entry).toBeDefined();
        // The two outcome buckets always inject their local finals.
        expect(Object.keys(lowered.states).sort()).toEqual(
            ["$end_abandoned", "$end_achieved", "$run", "$wait"],
        );

        const invoke = runOf(lowered);
        expect(invoke.src).toBe("classifyingNode");
        // SPEC 011: `$run.invoke.input` wraps the user input in the envelope
        // `{ userInput, event }`. `userInput` forwards the user callback's
        // result; `event` is the waking event (undefined on a dry run).
        const ctx: Ctx = { messages: ["hi"], count: 0 };
        const env = invoke.input({ context: ctx }) as { userInput: unknown; event: unknown };
        expect(env.userInput).toBe(ctx.messages);
        expect(env.event).toBeUndefined();
    });

    test("exits split across two levels: foo.onDone carries route targets; $run.invoke.onDone dispatches outcome → local finals", () => {
        const leaf = defineMode<Ctx, Events, P>({
            input: ({ context }) => context.messages,
            behavior: async () => ({ outcome: "achieved", payload: { intent: "greeting" } } satisfies ModeResult<P>),
            routes: {
                achieved: { target: "greetings" },
                abandoned: { target: "listening" },
            },
        });

        const lowered = buildActiveState(slotAt("classifying", leaf), undefined, {});
        // foo.onDone = the user's exits (was the old leaf `onDone` targets).
        expect(lowered.onDone).toMatchObject([
            { target: "greetings" },
            { target: "listening" },
        ]);
        // $run.invoke.onDone = outcome dispatch to the local `$end_*` finals.
        expect(runOf(lowered).onDone).toMatchObject([
            { target: "$end_achieved" },
            { target: "$end_abandoned" },
        ]);
    });

    test("RouteList form: each foo.onDone entry maps in array order; `target: END` → abandoned bucket sentinel (bubbles to parent)", () => {
        const leaf = defineMode<Ctx, Events, P>({
            input: ({ context }) => context.messages,
            behavior: async () => ({ outcome: "achieved", payload: { intent: "greeting" } } satisfies ModeResult<P>),
            routes: {
                achieved: [
                    { when: (p) => p.intent === "greeting", target: "greetings" },
                    { target: "improvising" },
                ],
                abandoned: [
                    { when: (p) => p.intent === "general", target: "listening" },
                    { target: END },
                ],
            },
        });

        const lowered = buildActiveState(slotAt("classifying", leaf), undefined, {});
        // foo.onDone preserves array order: 2 achieved entries, then 2 abandoned.
        // `target: END` on foo.onDone stays the abandoned bucket SENTINEL (a
        // symbol) — foo.onDone is what bubbles to the ENCLOSING compound, which
        // `compile.ts` resolves at the parent level (unchanged from pre-011). The
        // local `$end_abandoned` STRING only appears on `$run.invoke.onDone`
        // (the leaf's own outcome dispatch — asserted in the test above).
        expect(lowered.onDone).toMatchObject([
            { target: "greetings" },
            { target: "improvising" },
            { target: "listening" },
            { target: END_ABANDONED },
        ]);
    });

    test("stay continuations: replay → $run self-loop (reenter); waitOnEvent → $wait; $wait stamps readiness meta", () => {
        const leaf = defineMode<Ctx, Events, P>({
            input: ({ context }) => context.messages,
            events: ["MESSAGE"],
            behavior: async () => ({ stay: "replay", payload: { intent: "greeting" } } satisfies ModeResult<P>),
            routes: {
                achieved: { target: "greetings" },
                abandoned: { target: "listening" },
            },
            stay: {
                replay: {},
                waitOnEvent: {},
            },
        });

        const lowered = buildActiveState(slotAt("classifying", leaf), undefined, {});
        // $run.invoke.onDone: 2 exits, then replay (→ $run), then waitOnEvent (→ $wait).
        // SPEC 011: the old `retry` self-loop is now `stay:"replay"`, and it
        // targets the internal `$run` substate (path-independent) rather than
        // re-entering the mode by its last path segment.
        expect(runOf(lowered).onDone).toMatchObject([
            { target: "$end_achieved" },
            { target: "$end_abandoned" },
            { target: "$run", reenter: true },
            { target: "$wait" },
        ]);
        // $wait re-enters $run on a declared event and records readiness.
        expect(waitOf(lowered).on.MESSAGE).toMatchObject({ target: "$run", reenter: true });
        expect(waitOf(lowered).meta).toEqual({ atlasAwaiting: ["MESSAGE"] });
    });

    test("event mode (start:\"event\") parks on entry: initial is $wait", () => {
        const leaf = defineMode<Ctx, Events, P>({
            start: "event",
            events: ["MESSAGE"],
            input: ({ context }) => context.messages,
            behavior: async ({ event }) => ({ outcome: "achieved", payload: { intent: event.text === "hi" ? "greeting" : "general" } } satisfies ModeResult<P>),
            routes: {
                achieved: { target: "greetings" },
                abandoned: { target: "listening" },
            },
        });

        const lowered = buildActiveState(slotAt("idle", leaf), undefined, {});
        expect(lowered.initial).toBe("$wait");
        expect(waitOf(lowered).on.MESSAGE).toMatchObject({ target: "$run", reenter: true });
    });

    test("rejects a leaf with no behavior", () => {
        // SPEC 011: there is no passive `{ on: {} }` leaf — every mode has a
        // behavior. A config without one is rejected (was: "rejects a passive
        // leaf slot").
        const slot: LeafSlot = {
            kind: "leaf",
            path: "listening",
            config: { input: () => null } as unknown as Parameters<typeof buildActiveState>[0]["config"],
        };
        expect(() => buildActiveState(slot, undefined, {})).toThrow(/behavior/);
    });
});

describe("buildActiveState() — guards (5.7)", () => {
    test("$run.invoke.onDone: outcome-only guards dispatch achieved / abandoned / replay", () => {
        const leaf = defineMode<Ctx, Events, P>({
            input: ({ context }) => context.messages,
            behavior: async () => ({ outcome: "achieved", payload: { intent: "greeting" } } satisfies ModeResult<P>),
            routes: {
                achieved: { target: "next" },          // no `when`
                abandoned: { target: "fallback" },     // no `when`
            },
            stay: { replay: {} },                       // continuation
        });

        const lowered = buildActiveState(slotAt("classifying", leaf), undefined, {});
        const [achievedT, abandonedT, replayT] = runOf(lowered).onDone;

        // achieved guard fires only on outcome === "achieved"
        expect(achievedT?.guard?.(fakeDone({ outcome: "achieved", payload: { intent: "greeting" } }))).toBe(true);
        expect(achievedT?.guard?.(fakeDone({ outcome: "abandoned", payload: { intent: "greeting" } }))).toBe(false);

        // abandoned guard fires only on outcome === "abandoned"
        expect(abandonedT?.guard?.(fakeDone({ outcome: "abandoned", payload: { intent: "greeting" } }))).toBe(true);
        expect(abandonedT?.guard?.(fakeDone({ outcome: "achieved", payload: { intent: "greeting" } }))).toBe(false);

        // replay continuation fires only on stay === "replay"
        expect(replayT?.guard?.(fakeDone({ stay: "replay", payload: { intent: "greeting" } }))).toBe(true);
        expect(replayT?.guard?.(fakeDone({ stay: "waitOnEvent", payload: { intent: "greeting" } }))).toBe(false);
        expect(replayT?.guard?.(fakeDone({ outcome: "achieved", payload: { intent: "greeting" } }))).toBe(false);
    });

    test("foo.onDone: guard combines outcome check AND user's `when(payload)` (first match wins)", () => {
        const leaf = defineMode<Ctx, Events, P>({
            input: ({ context }) => context.messages,
            behavior: async () => ({ outcome: "achieved", payload: { intent: "greeting" } } satisfies ModeResult<P>),
            routes: {
                achieved: [
                    { when: (p) => p.intent === "greeting", target: "greetings" },
                    { target: "improvising" },
                ],
                abandoned: { target: "fallback" },
            },
        });

        const lowered = buildActiveState(slotAt("classifying", leaf), undefined, {});
        // foo.onDone[0],[1] are the two achieved entries; [2] is abandoned.
        const [guarded, fallback] = lowered.onDone;

        // guarded fires only when outcome === "achieved" AND payload.intent === "greeting"
        expect(guarded?.guard?.(fakeDone({ outcome: "achieved", payload: { intent: "greeting" } }))).toBe(true);
        expect(guarded?.guard?.(fakeDone({ outcome: "achieved", payload: { intent: "general" } }))).toBe(false);
        expect(guarded?.guard?.(fakeDone({ outcome: "abandoned", payload: { intent: "greeting" } }))).toBe(false);

        // default (no `when`) fires for any outcome === "achieved"
        expect(fallback?.guard?.(fakeDone({ outcome: "achieved", payload: { intent: "general" } }))).toBe(true);
        expect(fallback?.guard?.(fakeDone({ outcome: "achieved", payload: { intent: "greeting" } }))).toBe(true);
        expect(fallback?.guard?.(fakeDone({ outcome: "abandoned", payload: { intent: "general" } }))).toBe(false);
    });
});

describe("buildActiveState() — assign wrapping (5.7)", () => {
    test("user's `assign({ context, payload })` is applied to context via XState's assign(...)", async () => {
        type LocalP = { value: number };

        const leaf = defineMode<Ctx, Events, LocalP>({
            input: ({ context }) => context.messages,
            behavior: async () => ({ outcome: "achieved", payload: { value: 7 } } satisfies ModeResult<LocalP>),
            routes: {
                achieved: {
                    target: "done",
                    assign: ({ context, payload }) => ({
                        count: context.count + payload.value,
                        messages: [...context.messages, `value=${payload.value}`],
                    }),
                },
                abandoned: { target: "done" },
            },
        });

        const lowered = buildActiveState(slotAt("classifying", leaf), undefined, {});

        const machine = setup({
            types: {} as { context: Ctx; events: Events },
            actors: {
                classifyingNode: fromPromise(async () =>
                    ({ outcome: "achieved", payload: { value: 7 } } satisfies ModeResult<LocalP>),
                ),
            },
        }).createMachine({
            id: "test",
            initial: "classifying",
            context: { messages: ["hi"], count: 1 },
            states: {
                // SPEC 011: `lowered` is the mode's mini-compound; mount it as a
                // single compound state. Its `foo.onDone` assign runs exactly as
                // the old leaf transition's `assign` did.
                classifying: lowered as unknown as {
                    initial: string;
                    entry?: unknown;
                    states: Record<string, unknown>;
                    onDone: readonly unknown[];
                },
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

        // `$event: undefined` (entry-cleared slot) is ignored by toEqual.
        expect(actor.getSnapshot().context).toEqual({
            messages: ["hi", "value=7"],
            count: 8,
        });
    });

    test("missing `assign` → no `actions` field on the foo.onDone exit transitions", () => {
        const leaf = defineMode<Ctx, Events, P>({
            input: ({ context }) => context.messages,
            behavior: async () => ({ outcome: "achieved", payload: { intent: "greeting" } } satisfies ModeResult<P>),
            routes: {
                achieved: { target: "next" },          // no assign
                abandoned: { target: "fallback" },     // no assign
            },
        });

        const lowered = buildActiveState(slotAt("classifying", leaf), undefined, {});
        for (const t of lowered.onDone) {
            expect(t.actions).toBeUndefined();
        }
    });
});

describe("buildActiveState() — error routes → onError (5.9)", () => {
    test("`routes.error` omitted → no `onError` field on the lowered invoke", () => {
        const leaf = defineMode<Ctx, Events, P>({
            input: ({ context }) => context.messages,
            behavior: async () => ({ outcome: "achieved", payload: { intent: "greeting" } } satisfies ModeResult<P>),
            routes: {
                achieved: { target: "next" },
                abandoned: { target: "fallback" },
            },
        });
        const lowered = buildActiveState(slotAt("classifying", leaf), undefined, {});
        expect(runOf(lowered).onError).toBeUndefined();
    });

    test("single ErrorEntry → $run.invoke.onError filters to local $end_error; user target lands on foo.onDone", () => {
        const leaf = defineMode<Ctx, Events, P>({
            input: ({ context }) => context.messages,
            behavior: async () => ({ outcome: "achieved", payload: { intent: "greeting" } } satisfies ModeResult<P>),
            routes: {
                achieved: { target: "next" },
                abandoned: { target: "fallback" },
                error: { target: "errorState" },
            },
        });
        const lowered = buildActiveState(slotAt("classifying", leaf), undefined, {});
        // $run.invoke.onError routes the error to the LOCAL error final.
        expect(runOf(lowered).onError).toMatchObject([{ target: "$end_error" }]);
        const [t] = runOf(lowered).onError ?? [];
        // No `when` → fires for any error.
        expect(t?.guard?.(fakeErr(new Error("boom")))).toBe(true);
        expect(t?.guard?.(fakeErr("string-error"))).toBe(true);
        // The user's target is preserved on foo.onDone (last entry: the error route).
        const fooError = lowered.onDone[lowered.onDone.length - 1];
        expect(fooError?.target).toBe("errorState");
    });

    test("RouteList: `when(error)` filters at $run.invoke.onError; targets land on foo.onDone", () => {
        const leaf = defineMode<Ctx, Events, P>({
            input: ({ context }) => context.messages,
            behavior: async () => ({ outcome: "achieved", payload: { intent: "greeting" } } satisfies ModeResult<P>),
            routes: {
                achieved: { target: "next" },
                abandoned: { target: "fallback" },
                error: [
                    { when: (e) => e instanceof TypeError, target: "typeErrorState" },
                    { target: "errorState" },
                ],
            },
        });
        const lowered = buildActiveState(slotAt("classifying", leaf), undefined, {});
        const onError = runOf(lowered).onError ?? [];
        expect(onError).toHaveLength(2);

        const [guarded, defaultEntry] = onError;
        // guarded entry only fires for TypeError; both route to the local final.
        expect(guarded?.guard?.(fakeErr(new TypeError("nope")))).toBe(true);
        expect(guarded?.guard?.(fakeErr(new Error("normal")))).toBe(false);
        expect(guarded?.target).toBe("$end_error");
        expect(defaultEntry?.guard?.(fakeErr(new Error("normal")))).toBe(true);
        expect(defaultEntry?.guard?.(fakeErr(new TypeError("nope")))).toBe(true);
        expect(defaultEntry?.target).toBe("$end_error");

        // The user targets are preserved, in order, on foo.onDone (after the two exits).
        const fooErrors = lowered.onDone.slice(2);
        expect(fooErrors.map((t) => t.target)).toEqual(["typeErrorState", "errorState"]);
    });

    test("error `assign({ context, error })` is applied to context end-to-end", async () => {
        const boom = new Error("kaboom");

        const leaf = defineMode<Ctx, Events, P>({
            input: ({ context }) => context.messages,
            behavior: async () => {
                throw boom;
            },
            routes: {
                achieved: { target: "done" },
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

        const lowered = buildActiveState(slotAt("classifying", leaf), undefined, {});

        const machine = setup({
            types: {} as { context: Ctx; events: Events },
            actors: {
                classifyingNode: fromPromise<ModeResult<P>>(async () => {
                    throw boom;
                }),
            },
        }).createMachine({
            id: "test",
            initial: "classifying",
            context: { messages: ["hi"], count: 1 },
            states: {
                classifying: lowered as unknown as {
                    initial: string;
                    entry?: unknown;
                    states: Record<string, unknown>;
                    onDone: readonly unknown[];
                },
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
    test("`target: RE_THROW` produces a $run.invoke.onError transition with no target and a re-throw action", () => {
        const leaf = defineMode<Ctx, Events, P>({
            input: ({ context }) => context.messages,
            behavior: async () => ({ outcome: "achieved", payload: { intent: "greeting" } } satisfies ModeResult<P>),
            routes: {
                achieved: { target: "next" },
                abandoned: { target: "fallback" },
                error: { target: RE_THROW },
            },
        });
        const lowered = buildActiveState(slotAt("classifying", leaf), undefined, {});
        const t = runOf(lowered).onError?.[0];
        expect(t).toBeDefined();
        expect(t?.target).toBeUndefined();           // RE_THROW erases target
        expect(typeof t?.actions).toBe("function");   // a plain function, not assign()
    });

    test("the re-throw action throws the captured rejection when invoked", () => {
        const leaf = defineMode<Ctx, Events, P>({
            input: ({ context }) => context.messages,
            behavior: async () => ({ outcome: "achieved", payload: { intent: "greeting" } } satisfies ModeResult<P>),
            routes: {
                achieved: { target: "next" },
                abandoned: { target: "fallback" },
                error: { target: RE_THROW },
            },
        });
        const lowered = buildActiveState(slotAt("classifying", leaf), undefined, {});
        const action = runOf(lowered).onError?.[0]?.actions;
        if (typeof action !== "function") {
            throw new Error("expected re-throw action to be a plain function");
        }
        const boom = new TypeError("kaboom");
        expect(() => action({ event: { error: boom } })).toThrow(boom);
    });

    test("RE_THROW preserves the user's `when` filter — guard still fires conditionally", () => {
        const leaf = defineMode<Ctx, Events, P>({
            input: ({ context }) => context.messages,
            behavior: async () => ({ outcome: "achieved", payload: { intent: "greeting" } } satisfies ModeResult<P>),
            routes: {
                achieved: { target: "next" },
                abandoned: { target: "fallback" },
                error: [
                    { when: (e) => e instanceof TypeError, target: RE_THROW },
                    { target: "errorState" },
                ],
            },
        });
        const lowered = buildActiveState(slotAt("classifying", leaf), undefined, {});
        const [rethrowEntry, fallback] = runOf(lowered).onError ?? [];

        // RE_THROW entry's guard still filters by user's `when`.
        expect(rethrowEntry?.guard?.(fakeErr(new TypeError("yes")))).toBe(true);
        expect(rethrowEntry?.guard?.(fakeErr(new Error("no")))).toBe(false);
        expect(rethrowEntry?.target).toBeUndefined();
        expect(typeof rethrowEntry?.actions).toBe("function");

        // Fallback is a normal error route → local error final.
        expect(fallback?.target).toBe("$end_error");
    });

    test("`assign` on a RE_THROW entry is dropped at compile time", () => {
        let assignCalled = false;
        const leaf = defineMode<Ctx, Events, P>({
            input: ({ context }) => context.messages,
            behavior: async () => ({ outcome: "achieved", payload: { intent: "greeting" } } satisfies ModeResult<P>),
            routes: {
                achieved: { target: "next" },
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
        const lowered = buildActiveState(slotAt("classifying", leaf), undefined, {});
        const action = runOf(lowered).onError?.[0]?.actions;
        // Action is the bare re-throw, NOT the wrapped assign. Calling it throws
        // — it does not invoke the user's assign.
        if (typeof action !== "function") {
            throw new Error("expected re-throw action to be a plain function");
        }
        expect(() => action({ event: { error: new Error("x") } })).toThrow();
        expect(assignCalled).toBe(false);
    });
});
