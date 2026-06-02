// Runtime tests for `startAgent` and `formatModePath`.
//
// Spec: docs/specs/009-snapshot-aware-rehydration.md §Verification.
//
// Strategy: build minimal XState machines via `setup().createMachine()` and
// drive them through `startAgent`. This isolates the wrapper's plumbing
// (snapshot threading, inspect adaptation, auto-start, the `AgentSnapshot`
// brand) from the higher-level atlasjs constructors. The compound-local
// snapshot semantics that motivated the spec are tested directly: a value
// assigned in one boot must be present when a second `startAgent` rehydrates
// from the captured snapshot.

import { describe, expect, test } from "vitest";
import { assign, setup } from "xstate";

import { formatModePath } from "../src/formatModePath.ts";
import { startAgent } from "../src/startAgent.ts";
import type { AgentInspectionEvent } from "../src/types.ts";

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
