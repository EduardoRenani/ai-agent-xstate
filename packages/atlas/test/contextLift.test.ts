// Phase 5.13 runtime tests: compound-local context lift.
//
// Two layers:
//   1) Direct tests on `liftInput` / `liftExitAssign` / `liftErrorAssign` /
//      `liftGuard` / `makeCompoundEntry` / `makeCompoundExit` /
//      `compoundLocalKey` — bare invocation, no XState involved. These
//      pin the read-view shape and write-split semantics.
//   2) Integration via `buildActiveState(slot, lift)` driven through a
//      live XState machine. This proves the wrapped callbacks behave
//      correctly when XState calls them (input → behavior → assign), and
//      that writes land in the right destination (agent root vs. compound
//      slot).
//
// Spec: docs/specs/004-tasks.md Phase 5.13.

import { describe, expect, test } from "vitest";
import { createActor, fromPromise, setup } from "xstate";

import {
    compoundLocalKey,
    liftErrorAssign,
    liftExitAssign,
    liftGuard,
    liftInput,
    makeCompoundEntry,
    makeCompoundExit,
    type LiftContext,
} from "../src/contextLift.ts";
import { buildActiveState } from "../src/buildActiveState.ts";
import type { LeafSlot } from "../src/walk.ts";
import type { ActiveLeafModeConfig, ModeOutput } from "../src/types.ts";

describe("compoundLocalKey()", () => {
    test("single segment → `__<name>_local`", () => {
        expect(compoundLocalKey("socratic")).toBe("__socratic_local");
    });

    test("dotted path → underscores", () => {
        expect(compoundLocalKey("socratic.evaluating")).toBe("__socratic_evaluating_local");
    });

    test("deep path", () => {
        expect(compoundLocalKey("a.b.c.d")).toBe("__a_b_c_d_local");
    });

    test("throws on empty path", () => {
        expect(() => compoundLocalKey("")).toThrow(/empty path/);
    });
});

describe("liftInput()", () => {
    test("user sees only inherit + local keys", () => {
        const lift: LiftContext = {
            key: "__socratic_local",
            inherit: ["messages"],
            initialLocal: { attempts: 0 },
        };
        let seen: unknown;
        const lifted = liftInput(({ context }) => {
            seen = context;
            return {};
        }, lift);
        lifted({
            context: {
                messages: ["hi"],
                hidden: "should not be visible",
                __socratic_local: { attempts: 2 },
            },
        });
        expect(seen).toEqual({ messages: ["hi"], attempts: 2 });
    });

    test("local keys read undefined when slot is not yet initialized", () => {
        const lift: LiftContext = {
            key: "__socratic_local",
            inherit: ["messages"],
            initialLocal: { attempts: 0 },
        };
        let seen: unknown;
        const lifted = liftInput(({ context }) => {
            seen = context;
            return {};
        }, lift);
        lifted({ context: { messages: ["hi"] } });
        expect(seen).toEqual({ messages: ["hi"], attempts: undefined });
    });
});

describe("liftExitAssign()", () => {
    const lift: LiftContext = {
        key: "__socratic_local",
        inherit: ["messages"],
        initialLocal: { attempts: 0 },
    };

    test("inherit write goes to root, local write goes to slot", () => {
        const action = liftExitAssign(
            ({ context, payload }) => {
                const c = context as { messages: string[]; attempts: number };
                const p = payload as { msg: string };
                return {
                    messages: [...c.messages, p.msg],
                    attempts: c.attempts + 1,
                };
            },
            lift,
        );
        // XState v5 assign callback shape: ({ context, event }) => Partial<TContext>
        const fn = (action as unknown as {
            assignment: (args: { context: unknown; event: unknown }) => Record<string, unknown>;
        }).assignment;
        const patch = fn({
            context: {
                messages: ["hi"],
                __socratic_local: { attempts: 2 },
            },
            event: { output: { outcome: "achieved", payload: { msg: "yo" } } },
        });
        expect(patch).toEqual({
            messages: ["hi", "yo"],
            __socratic_local: { attempts: 3 },
        });
    });

    test("out-of-scope keys are silently dropped", () => {
        const action = liftExitAssign(
            () => ({ messages: ["x"], totallyUnknown: 999 }),
            lift,
        );
        const fn = (action as unknown as {
            assignment: (args: { context: unknown; event: unknown }) => Record<string, unknown>;
        }).assignment;
        const patch = fn({
            context: { messages: [], __socratic_local: { attempts: 0 } },
            event: { output: { outcome: "achieved", payload: {} } },
        });
        expect(patch).toEqual({ messages: ["x"] });
        expect(patch).not.toHaveProperty("totallyUnknown");
    });
});

describe("liftErrorAssign()", () => {
    test("error reaches user callback; write split applies", () => {
        const lift: LiftContext = {
            key: "__foo_local",
            inherit: ["log"],
            initialLocal: { lastError: "" },
        };
        const action = liftErrorAssign(
            ({ context, error }) => {
                const c = context as { log: string[]; lastError: string };
                const msg = (error as Error).message;
                return {
                    log: [...c.log, msg],
                    lastError: msg,
                };
            },
            lift,
        );
        const fn = (action as unknown as {
            assignment: (args: { context: unknown; event: unknown }) => Record<string, unknown>;
        }).assignment;
        const patch = fn({
            context: { log: [], __foo_local: { lastError: "" } },
            event: { error: new Error("boom") },
        });
        expect(patch).toEqual({
            log: ["boom"],
            __foo_local: { lastError: "boom" },
        });
    });
});

describe("liftGuard()", () => {
    test("user guard sees the lifted view", () => {
        const lift: LiftContext = {
            key: "__foo_local",
            inherit: ["messages"],
            initialLocal: { attempts: 0 },
        };
        const guard = liftGuard(({ context }) => {
            const c = context as { messages: string[]; attempts: number };
            return c.attempts < 3 && c.messages.length > 0;
        }, lift);
        expect(
            guard({
                context: { messages: ["hi"], __foo_local: { attempts: 2 } },
                event: { type: "X" },
            }),
        ).toBe(true);
        expect(
            guard({
                context: { messages: ["hi"], __foo_local: { attempts: 3 } },
                event: { type: "X" },
            }),
        ).toBe(false);
        expect(
            guard({
                context: { messages: [], __foo_local: { attempts: 0 } },
                event: { type: "X" },
            }),
        ).toBe(false);
    });
});

describe("nested lift (parent chain)", () => {
    // Outer A has local { outerCount } inheriting `messages` from root.
    // Inner B inherits ["messages", "outerCount"] from A, with own
    // local { innerCount }.
    const outerLift: LiftContext = {
        key: "__a_local",
        inherit: ["messages"],
        initialLocal: { outerCount: 0 },
    };
    const innerLift: LiftContext = {
        key: "__a_b_local",
        inherit: ["messages", "outerCount"],
        initialLocal: { innerCount: 0 },
        parent: outerLift,
    };

    test("inner sees messages (from root) and outerCount (from outer slot) and its own innerCount", () => {
        let seen: unknown;
        const lifted = liftInput(({ context }) => {
            seen = context;
            return {};
        }, innerLift);
        lifted({
            context: {
                messages: ["m"],
                __a_local: { outerCount: 7 },
                __a_b_local: { innerCount: 3 },
            },
        });
        expect(seen).toEqual({ messages: ["m"], outerCount: 7, innerCount: 3 });
    });

    test("inner write to inherited outer-local routes to outer slot, NOT root", () => {
        const action = liftExitAssign(
            ({ context }) => {
                const c = context as {
                    messages: string[];
                    outerCount: number;
                    innerCount: number;
                };
                return {
                    messages: [...c.messages, "new"],
                    outerCount: c.outerCount + 10,
                    innerCount: c.innerCount + 1,
                };
            },
            innerLift,
        );
        const fn = (action as unknown as {
            assignment: (args: { context: unknown; event: unknown }) => Record<string, unknown>;
        }).assignment;
        const patch = fn({
            context: {
                messages: ["hi"],
                __a_local: { outerCount: 5 },
                __a_b_local: { innerCount: 0 },
            },
            event: { output: { outcome: "achieved", payload: {} } },
        });
        expect(patch).toEqual({
            messages: ["hi", "new"],
            __a_local: { outerCount: 15 },
            __a_b_local: { innerCount: 1 },
        });
    });
});

describe("makeCompoundEntry() / makeCompoundExit()", () => {
    const lift: LiftContext = {
        key: "__socratic_local",
        inherit: ["messages"],
        initialLocal: { attempts: 0, lastSeen: "" },
    };

    test("entry initializes the slot from initialLocal", () => {
        const entry = makeCompoundEntry(lift);
        // assign(...) with an object map: each key is a function called
        // with the args; result builds the patch.
        const out = (entry as unknown as { assignment: Record<string, (args: unknown) => unknown> })
            .assignment;
        expect(out.__socratic_local({})).toEqual({ attempts: 0, lastSeen: "" });
    });

    test("entry returns a fresh copy each call (no shared reference between entries)", () => {
        const entry = makeCompoundEntry(lift);
        const out = (entry as unknown as { assignment: Record<string, (args: unknown) => unknown> })
            .assignment;
        const a = out.__socratic_local({});
        const b = out.__socratic_local({});
        expect(a).toEqual(b);
        expect(a).not.toBe(b);
    });

    test("exit clears the slot to undefined", () => {
        const exit = makeCompoundExit(lift);
        const out = (exit as unknown as { assignment: Record<string, (args: unknown) => unknown> })
            .assignment;
        expect(out.__socratic_local({})).toBe(undefined);
    });
});

describe("integration with buildActiveState(slot, lift)", () => {
    test("input wrapper presents lifted view, assign splits writes via XState", async () => {
        const lift: LiftContext = {
            key: "__socratic_local",
            inherit: ["messages"],
            initialLocal: { attempts: 0 },
        };

        type LiftedContext = { messages: string[]; attempts: number };
        type ReceivedInput = { messages: string[]; attempts: number };

        const config: ActiveLeafModeConfig<LiftedContext, { type: string }, { reply: string }> = {
            input: ({ context }) => ({
                messages: context.messages,
                attempts: context.attempts,
            }),
            behavior: async ({ input }) => {
                const i = input as ReceivedInput;
                return {
                    outcome: "achieved",
                    payload: { reply: `msgs=${i.messages.length},attempts=${i.attempts}` },
                };
            },
            routes: {
                achieved: {
                    target: "done",
                    assign: ({ context, payload }) => ({
                        messages: [...context.messages, payload.reply],
                        attempts: context.attempts + 1,
                    }),
                },
                retry: [],
                abandoned: { target: "done" },
            },
        };

        const slot: LeafSlot = {
            kind: "leaf",
            path: "socratic.thinking",
            // The slot config carries the runtime shape — typing widens here.
            config: config as unknown as LeafSlot["config"],
        };

        const lowered = buildActiveState(slot, lift);

        // Mount the lowered leaf as an atomic state of a machine whose root
        // context carries both inherit (`messages`) and the compound's
        // local slot (`__socratic_local: { attempts: 2 }`).
        type RootCtx = { messages: string[]; __socratic_local: { attempts: number } };
        const machine = setup({
            types: {} as { context: RootCtx },
            actors: {
                [lowered.invoke.src]: fromPromise(async ({ input }) => {
                    // Bridge: this actor runs the user's `behavior` via the
                    // wrapped input. `lowered.invoke.input(...)` is what
                    // XState would call to build this actor's input.
                    return config.behavior({ input });
                }),
            },
        }).createMachine({
            id: "lift-int",
            initial: "thinking",
            context: { messages: ["seed"], __socratic_local: { attempts: 2 } },
            states: {
                thinking: lowered as unknown as {
                    invoke: {
                        src: string;
                        input: (args: { context: RootCtx }) => unknown;
                        onDone: readonly { target?: string; actions?: unknown }[];
                    };
                },
                done: { type: "final" },
            },
        });

        const actor = createActor(machine);
        actor.start();
        await new Promise<void>((resolve) => {
            actor.subscribe((state) => {
                if (state.value === "done") resolve();
            });
        });

        // Root context after the leaf finished: `messages` got the new
        // reply (inherit write to root), and `__socratic_local.attempts`
        // bumped (local write to slot). `messages` includes the seed plus
        // the assigned reply; reply reads attempts=2 from the slot view.
        const snap = actor.getSnapshot();
        expect(snap.context).toEqual({
            messages: ["seed", "msgs=1,attempts=2"],
            __socratic_local: { attempts: 3 },
        });
    });
});

// Exercise that a wrapped `behavior` rejection routes through the lifted
// error assign and the write splits correctly. Uses the lower-level
// `buildActiveState` integration like the test above.
describe("integration: error route under a lift", () => {
    test("error assign sees lifted view; split applies", async () => {
        const lift: LiftContext = {
            key: "__foo_local",
            inherit: ["log"],
            initialLocal: { lastError: "" },
        };
        type LiftedContext = { log: string[]; lastError: string };

        const config: ActiveLeafModeConfig<LiftedContext, { type: string }, { ok: boolean }> = {
            input: ({ context }) => ({ log: context.log }),
            behavior: async () => {
                throw new Error("kaboom");
            },
            routes: {
                achieved: { target: "done" },
                retry: [],
                abandoned: { target: "done" },
                error: {
                    target: "done",
                    assign: ({ context, error }) => ({
                        log: [...context.log, (error as Error).message],
                        lastError: (error as Error).message,
                    }),
                },
            },
        };
        const slot: LeafSlot = {
            kind: "leaf",
            path: "foo",
            config: config as unknown as LeafSlot["config"],
        };
        const lowered = buildActiveState(slot, lift);

        type RootCtx = { log: string[]; __foo_local: { lastError: string } };
        const machine = setup({
            types: {} as { context: RootCtx },
            actors: {
                [lowered.invoke.src]: fromPromise(async () => {
                    throw new Error("kaboom");
                }) as unknown as ReturnType<typeof fromPromise>,
            },
        }).createMachine({
            id: "lift-err",
            initial: "foo",
            context: { log: [], __foo_local: { lastError: "" } },
            states: {
                foo: lowered as unknown as {
                    invoke: {
                        src: string;
                        input: (args: { context: RootCtx }) => unknown;
                        onDone: readonly unknown[];
                        onError?: readonly unknown[];
                    };
                },
                done: { type: "final" },
            },
        });

        const actor = createActor(machine);
        actor.start();
        await new Promise<void>((resolve) => {
            actor.subscribe((state) => {
                if (state.value === "done") resolve();
            });
        });

        const snap = actor.getSnapshot();
        expect(snap.context).toEqual({
            log: ["kaboom"],
            __foo_local: { lastError: "kaboom" },
        });
    });
});

// Verifies the inverse: when `buildActiveState` is called WITHOUT a lift,
// the wrapped callbacks pass through `context` unchanged. (Backward-compat
// check — the existing buildActiveState suite already covers the no-lift
// shape with `toMatchObject`, but this nails down the semantic.)
describe("buildActiveState without lift (backward compatibility)", () => {
    test("input and assign see the full root context verbatim", async () => {
        type Ctx = { count: number; tag: string };
        const config: ActiveLeafModeConfig<Ctx, { type: string }, { result: string }> = {
            input: ({ context }) => ({ count: context.count, tag: context.tag }),
            behavior: async ({ input }) => {
                const i = input as { count: number; tag: string };
                return { outcome: "achieved", payload: { result: `${i.tag}=${i.count}` } };
            },
            routes: {
                achieved: {
                    target: "done",
                    assign: ({ context, payload }) => ({
                        count: context.count + 1,
                        tag: `${context.tag}/${payload.result}`,
                    }),
                },
                retry: [],
                abandoned: { target: "done" },
            },
        };
        const slot: LeafSlot = {
            kind: "leaf",
            path: "plain",
            config: config as unknown as LeafSlot["config"],
        };
        const lowered = buildActiveState(slot); // no lift

        const machine = setup({
            types: {} as { context: Ctx },
            actors: {
                [lowered.invoke.src]: fromPromise(async ({ input }) => config.behavior({ input })),
            },
        }).createMachine({
            id: "no-lift",
            initial: "plain",
            context: { count: 4, tag: "t" },
            states: {
                plain: lowered as unknown as {
                    invoke: {
                        src: string;
                        input: (args: { context: Ctx }) => unknown;
                        onDone: readonly unknown[];
                    };
                },
                done: { type: "final" },
            },
        });

        const actor = createActor(machine);
        actor.start();
        await new Promise<void>((resolve) => {
            actor.subscribe((state) => {
                if (state.value === "done") resolve();
            });
        });

        expect(actor.getSnapshot().context).toEqual({
            count: 5,
            tag: "t/t=4",
        });
    });
});

// Ensure `ModeOutput` import in the file isn't dropped by the linter — it
// is referenced by `ActiveLeafModeConfig` generics at the call sites above.
const _modeOutputAnchor: ModeOutput<unknown> = { outcome: "achieved", payload: undefined };
void _modeOutputAnchor;
