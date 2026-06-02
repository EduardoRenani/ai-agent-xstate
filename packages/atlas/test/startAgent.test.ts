// Runtime tests for `startAgent` and `formatModePath`.
//
// Spec: docs/specs/009-snapshot-aware-rehydration.md §Verification.
//       docs/specs/010-error-channel.md §Verification (onError scenarios).
//
// Strategy: build minimal XState machines via `setup().createMachine()` and
// drive them through `startAgent`. This isolates the wrapper's plumbing
// (snapshot threading, inspect adaptation, auto-start, the `AgentSnapshot`
// brand) from the higher-level atlasjs constructors. The compound-local
// snapshot semantics that motivated the spec are tested directly: a value
// assigned in one boot must be present when a second `startAgent` rehydrates
// from the captured snapshot.

import { describe, expect, test } from "vitest";
import { assign, fromPromise, setup } from "xstate";

import { formatModePath } from "../src/formatModePath.ts";
import { startAgent } from "../src/startAgent.ts";
import type { AgentErrorInfo, AgentInspectionEvent } from "../src/types.ts";

// ── Test machines ────────────────────────────────────────────────────

// Minimal counter machine: `INC` increments, `BACK` returns to idle. Used to
// prove (a) state survives a snapshot round-trip, and (b) `inspect` emits
// transition events with the correct from/to.
type CounterCtx = { counter: number };
type CounterEv = { type: "INC" } | { type: "BACK" };

const counterMachine = setup({
    types: {
        context: {} as CounterCtx,
        events: {} as CounterEv,
    },
    actions: {
        inc: assign(({ context }) => ({ counter: context.counter + 1 })),
    },
}).createMachine({
    id: "counter",
    initial: "idle",
    context: { counter: 0 },
    states: {
        idle: {
            on: {
                INC: { target: "active", actions: "inc" },
            },
        },
        active: {
            on: {
                INC: { target: "active", actions: "inc", reenter: true },
                BACK: { target: "idle" },
            },
        },
    },
});

// Nested machine: drives `formatModePath` through a compound value.
const nestedMachine = setup({
    types: { events: {} as { type: "GO" } | { type: "DEEPER" } | { type: "DONE" } },
}).createMachine({
    id: "nested",
    initial: "outer",
    states: {
        outer: {
            on: { GO: "compound" },
        },
        compound: {
            initial: "child",
            states: {
                child: {
                    on: { DEEPER: "grandchild" },
                },
                grandchild: {
                    on: { DONE: "#nested.outer" },
                },
            },
        },
    },
});

// ── formatModePath ───────────────────────────────────────────────────

describe("formatModePath()", () => {
    test("string value passes through", () => {
        expect(formatModePath("idle")).toBe("idle");
    });

    test("single-level compound joins with dot", () => {
        expect(formatModePath({ compound: "child" })).toBe("compound.child");
    });

    test("deep compound recurses", () => {
        expect(formatModePath({ a: { b: { c: "leaf" } } })).toBe("a.b.c.leaf");
    });

    test("throws on parallel regions (>1 key)", () => {
        expect(() => formatModePath({ regionA: "x", regionB: "y" })).toThrow(
            /parallel regions/,
        );
    });
});

// ── startAgent: auto-start ───────────────────────────────────────────

describe("startAgent() auto-start", () => {
    test("returned actor accepts send() without explicit start", () => {
        const actor = startAgent<CounterCtx, CounterEv>(counterMachine);
        expect(() => actor.send({ type: "INC" })).not.toThrow();
        actor.stop();
    });
});

// ── startAgent: snapshot round-trip ──────────────────────────────────

describe("startAgent() snapshot round-trip", () => {
    test("context written before snapshot survives rehydration", () => {
        const first = startAgent<CounterCtx, CounterEv>(counterMachine);
        first.send({ type: "INC" });
        first.send({ type: "INC" });
        first.send({ type: "INC" });
        const snap = first.getSnapshot();
        first.stop();

        const second = startAgent<CounterCtx, CounterEv>(counterMachine, {
            snapshot: snap,
        });
        // The second boot's first observed context should already carry
        // the three INCs from the first boot.
        let observedContext: CounterCtx | undefined;
        second.stop();
        // Capture context via a fresh actor + inspect on a no-op send to
        // surface the post-restore snapshot.
        const probe = startAgent<CounterCtx, CounterEv>(counterMachine, {
            snapshot: snap,
            inspect: (e) => {
                if (e.type === "transition") observedContext = e.context;
            },
        });
        // Force an observable transition so inspect fires post-restore.
        probe.send({ type: "BACK" });
        probe.stop();

        expect(observedContext).toBeDefined();
        expect(observedContext?.counter).toBe(3);
    });

    test("AgentSnapshot carries the coarse version tag", () => {
        const actor = startAgent<CounterCtx, CounterEv>(counterMachine);
        const snap = actor.getSnapshot();
        actor.stop();
        // Coarse tag, decoupled from package version — bumped only when
        // the snapshot shape itself changes.
        expect(snap.atlasVersion).toBe("1");
    });

    test("snapshot from a fresh actor is non-empty (persists `idle` initial)", () => {
        const actor = startAgent<CounterCtx, CounterEv>(counterMachine);
        const snap = actor.getSnapshot();
        actor.stop();
        expect(snap.persisted).toBeDefined();
    });
});

// ── startAgent: inspect adaptation ───────────────────────────────────

describe("startAgent() inspect adapter", () => {
    test("emits transition on path change, suppresses repeats", () => {
        const events: AgentInspectionEvent<CounterCtx>[] = [];
        const actor = startAgent<CounterCtx, CounterEv>(counterMachine, {
            inspect: (e) => events.push(e),
        });
        // Boot → `idle`. Expect one transition observation: (init) → idle.
        const initialCount = events.length;
        expect(initialCount).toBeGreaterThanOrEqual(1);
        expect(events[initialCount - 1]?.to).toBe("idle");
        expect(events[initialCount - 1]?.from).toBe("(init)");

        // idle → active.
        actor.send({ type: "INC" });
        const afterFirstInc = events.length;
        expect(afterFirstInc).toBeGreaterThan(initialCount);
        expect(events[afterFirstInc - 1]?.from).toBe("idle");
        expect(events[afterFirstInc - 1]?.to).toBe("active");

        // active → active (reenter). Counter changes, but the path doesn't,
        // so NO new transition event should fire.
        actor.send({ type: "INC" });
        // Wait: re-enter under the same path key — XState DOES emit a
        // snapshot event, but `next === previousPath` so the wrapper drops
        // it. Assert no new entry in `events`.
        expect(events.length).toBe(afterFirstInc);

        // active → idle.
        actor.send({ type: "BACK" });
        const afterBack = events.length;
        expect(afterBack).toBeGreaterThan(afterFirstInc);
        expect(events[afterBack - 1]?.from).toBe("active");
        expect(events[afterBack - 1]?.to).toBe("idle");

        actor.stop();
    });

    test("nested mode paths are dot-joined", () => {
        const transitions: string[] = [];
        const actor = startAgent<unknown, { type: "GO" } | { type: "DEEPER" } | { type: "DONE" }>(
            nestedMachine,
            {
                inspect: (e) => {
                    if (e.type === "transition") {
                        transitions.push(`${e.from} → ${e.to}`);
                    }
                },
            },
        );
        actor.send({ type: "GO" });
        actor.send({ type: "DEEPER" });
        actor.send({ type: "DONE" });
        actor.stop();

        // Expect at least: (init) → outer, outer → compound.child,
        // compound.child → compound.grandchild, compound.grandchild → outer.
        expect(transitions).toEqual(
            expect.arrayContaining([
                "(init) → outer",
                "outer → compound.child",
                "compound.child → compound.grandchild",
                "compound.grandchild → outer",
            ]),
        );
    });

    test("inspect is optional — actor works without it", () => {
        const actor = startAgent<CounterCtx, CounterEv>(counterMachine);
        expect(() => actor.send({ type: "INC" })).not.toThrow();
        actor.stop();
    });
});

// ── startAgent: onError channel (spec 010) ───────────────────────────

// Test machines for spec 010. Each variant invokes a rejecting actor; the
// difference is what (if anything) the failing state declares for
// `invoke.onError`.

type ErrEv = { type: "GO" };

const BOOM = new Error("boom");

const rejectingActor = fromPromise(async () => {
    throw BOOM;
});

// Variant A — no `onError` route. Rejection escapes the machine.
const escapeMachine = setup({
    types: { context: {} as { last?: string }, events: {} as ErrEv },
    actors: { rejecting: rejectingActor },
}).createMachine({
    id: "escape",
    initial: "idle",
    context: {},
    states: {
        idle: { on: { GO: "failing" } },
        failing: {
            invoke: { src: "rejecting" },
        },
    },
});

// Variant B — `routes.error.target: sibling` recovers the rejection.
const recoverMachine = setup({
    types: { context: {} as { last?: string }, events: {} as ErrEv },
    actors: { rejecting: rejectingActor },
}).createMachine({
    id: "recover",
    initial: "idle",
    context: {},
    states: {
        idle: { on: { GO: "failing" } },
        failing: {
            invoke: {
                src: "rejecting",
                onError: {
                    target: "recovered",
                    actions: assign({ last: "handled" }),
                },
            },
        },
        recovered: {},
    },
});

// Variant C — context written by an earlier transition is visible to
// `onError` when a later leaf rejects. Models spec 010 §Verification #6.
const preFailMachine = setup({
    types: { context: {} as { runId?: string }, events: {} as ErrEv },
    actors: { rejecting: rejectingActor },
}).createMachine({
    id: "prefail",
    initial: "stamp",
    context: {},
    states: {
        // `stamp` writes runId on entry, then auto-transitions to failing.
        stamp: {
            entry: assign({ runId: "r1" }),
            always: "failing",
        },
        failing: {
            invoke: { src: "rejecting" },
        },
    },
});

// `fromPromise` rejections settle on the microtask queue, so each test
// awaits an explicit settle gate after the triggering `send`. The gate
// resolves on either `onError` (escape) or an `inspect` transition the
// test cares about (recovery), to avoid arbitrary timer delays.

function flushMicrotasks(): Promise<void> {
    return new Promise((r) => setTimeout(r, 0));
}

describe("startAgent() onError channel", () => {
    test("escape: onError fires once with mode-path, error, and snapshot", async () => {
        const calls: AgentErrorInfo<{ last?: string }>[] = [];
        let resolveErr: (() => void) | null = null;
        const errored = new Promise<void>((r) => { resolveErr = r; });
        const actor = startAgent<{ last?: string }, ErrEv>(escapeMachine, {
            onError: (info) => {
                calls.push(info);
                if (resolveErr) { resolveErr(); resolveErr = null; }
            },
        });
        actor.send({ type: "GO" });
        await errored;

        expect(calls.length).toBe(1);
        const info = calls[0];
        expect(info).toBeDefined();
        if (info === undefined) throw new Error("unreachable");
        expect(info.error).toBe(BOOM);
        expect(info.modePath).toBe("failing");
        expect(info.snapshot.atlasVersion).toBe("1");
    });

    test("recover (intra-machine): onError does NOT fire", async () => {
        const errs: unknown[] = [];
        const transitions: string[] = [];
        let resolveRecovered: (() => void) | null = null;
        const recovered = new Promise<void>((r) => { resolveRecovered = r; });
        const actor = startAgent<{ last?: string }, ErrEv>(recoverMachine, {
            inspect: (e) => {
                transitions.push(`${e.from} → ${e.to}`);
                if (e.to === "recovered" && resolveRecovered) {
                    resolveRecovered();
                    resolveRecovered = null;
                }
            },
            onError: (info) => errs.push(info),
        });
        actor.send({ type: "GO" });
        await recovered;

        expect(errs).toEqual([]);
        expect(transitions).toEqual(
            expect.arrayContaining([
                "(init) → idle",
                "idle → failing",
                "failing → recovered",
            ]),
        );
        actor.stop();
    });

    test("info.context reflects pre-failure root context", async () => {
        const calls: AgentErrorInfo<{ runId?: string }>[] = [];
        let resolveErr: (() => void) | null = null;
        const errored = new Promise<void>((r) => { resolveErr = r; });
        // preFailMachine auto-transitions from `stamp` (assigns runId="r1")
        // into `failing` (rejects), so we don't even need to send an event:
        // the failure path runs to completion on boot.
        startAgent<{ runId?: string }, ErrEv>(preFailMachine, {
            onError: (info) => {
                calls.push(info);
                if (resolveErr) { resolveErr(); resolveErr = null; }
            },
        });
        await errored;

        expect(calls.length).toBe(1);
        const info = calls[0];
        expect(info).toBeDefined();
        if (info === undefined) throw new Error("unreachable");
        // The earlier `entry: assign(runId="r1")` is observed by onError —
        // proves the snapshot is captured synchronously inside subscribe.error
        // and reflects the context the failing leaf actually saw.
        expect(info.context.runId).toBe("r1");
        expect(info.modePath).toBe("failing");
    });

    test("snapshot at error points at the failed leaf (pre-terminal)", async () => {
        let captured: AgentErrorInfo<{ last?: string }> | undefined;
        let resolveErr: (() => void) | null = null;
        const errored = new Promise<void>((r) => { resolveErr = r; });
        const first = startAgent<{ last?: string }, ErrEv>(escapeMachine, {
            onError: (info) => {
                captured = info;
                if (resolveErr) { resolveErr(); resolveErr = null; }
            },
        });
        first.send({ type: "GO" });
        await errored;
        expect(captured).toBeDefined();
        if (captured === undefined) throw new Error("unreachable");

        // The captured snapshot's persisted `value` still names the failed
        // leaf — proving the snapshot was taken pre-terminal-cleanup. This
        // is the contract that lets a host re-enter the failed leaf by
        // feeding `info.snapshot` to a fresh `startAgent({ snapshot })`.
        // We assert on the persisted shape directly because re-booting an
        // actor in error status surfaces XState lifecycle quirks
        // orthogonal to this contract.
        const persisted = captured.snapshot.persisted as { value: unknown };
        expect(formatModePath(persisted.value)).toBe("failing");
    });

    test("onError omitted: wrapper boots without observing the error channel", () => {
        // Direct runtime check that constructing `startAgent` without
        // `onError` produces a working actor whose surface is unchanged
        // from spec 009. The "no subscribe call" contract itself is
        // structurally enforced by `startAgent.ts`'s
        // `if (userOnError !== undefined)` guard — a runtime assertion
        // would have to spy on XState's actor internals (which the
        // wrapper deliberately hides). The spec's Verification #4 cites
        // the code site; we cover that the surface still works here.
        const inspects: AgentInspectionEvent<{ last?: string }>[] = [];
        const actor = startAgent<{ last?: string }, ErrEv>(escapeMachine, {
            inspect: (e) => inspects.push(e),
        });
        // Boot path still emits the initial transition.
        expect(inspects.map((e) => `${e.from} → ${e.to}`)).toEqual(
            expect.arrayContaining(["(init) → idle"]),
        );
        actor.stop();
    });
});
