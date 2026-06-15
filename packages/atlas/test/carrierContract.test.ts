// Carrier contract tests — pin the load-bearing XState behaviors Atlas relies
// on but does not own.
//
// Spec: docs/specs/012-xstate-containment.md §P20 + §Hardening.
//
// SPEC: "New test/carrierContract.test.ts pinning the three P20 behaviors
//        against the installed xstate. These tests are the tripwire for any
//        future xstate bump."
//
// These assertions exercise the carrier (`xstate`) DIRECTLY, not through Atlas
// wrappers — the point is to detect drift in xstate itself under the pinned
// `~5.31` range (C3). Each `describe` maps to one row of the P20 table; if any
// goes red after an xstate bump, a shipped Atlas contract has silently broken.

import { createActor, assign, fromPromise, setup } from "xstate";
import { describe, expect, test } from "vitest";

// ── Behavior 1 — restore does NOT re-run `entry` actions ─────────────────
//
// SPEC: P20 row 1 — "Restore does not re-run `entry` actions" → "Whole
//       spec-009 persistence model (compound locals survive)"
//       (relied on at startAgent.ts:35-38).
//
// A counter mutated inside an `entry` action proves the action fired exactly
// once on the live boot and NOT again when a fresh actor rehydrates into the
// same state from the persisted snapshot.

describe("P20.1 — restore does not re-run entry actions", () => {
    test("entry fires on first enter, not on snapshot restore", () => {
        let entryRuns = 0;
        const machine = setup({
            types: {
                context: {} as { marked: boolean },
                events: {} as { type: "GO" },
            },
            actions: {
                // Impure on purpose: counts how many times `live` is entered.
                mark: () => {
                    entryRuns += 1;
                },
            },
        }).createMachine({
            id: "entry",
            initial: "idle",
            context: { marked: false },
            states: {
                idle: { on: { GO: "live" } },
                live: { entry: ["mark", assign({ marked: true })] },
            },
        });

        const live = createActor(machine).start();
        live.send({ type: "GO" });
        expect(entryRuns).toBe(1);
        const persisted = live.getPersistedSnapshot();
        live.stop();

        // Rehydrate into `live`. If xstate re-ran `entry` here, the spec-009
        // persistence model (compound locals survive restore) would be broken.
        const restored = createActor(machine, { snapshot: persisted }).start();
        expect(entryRuns).toBe(1);
        expect(restored.getSnapshot().context.marked).toBe(true);
        restored.stop();
    });
});

// ── Behavior 2 — at error time, `getSnapshot()` still carries value/context ─
//
// SPEC: P20 row 2 — "At error time, getSnapshot() still has value/context
//       populated" → "Spec-010 AgentErrorInfo.modePath/context/snapshot"
//       (relied on at startAgent.ts:113-117, comment pins xstate@5.31.1).
//
// An invoked actor rejects with no `onError` route, so the rejection escapes.
// Inside the `error` subscriber the snapshot must still name the failed leaf
// and expose the context the leaf saw — this is what feeds AgentErrorInfo.

describe("P20.2 — snapshot at error time keeps value and context", () => {
    test("error subscriber sees the failed leaf and populated context", async () => {
        const BOOM = new Error("carrier-boom");
        const rejecting = fromPromise(async () => {
            throw BOOM;
        });
        const machine = setup({
            types: {
                context: {} as { stamp: string },
                events: {} as { type: "GO" },
            },
            actors: { rejecting },
        }).createMachine({
            id: "err",
            initial: "idle",
            context: { stamp: "set" },
            states: {
                idle: { on: { GO: "failing" } },
                failing: { invoke: { src: "rejecting" } },
            },
        });

        const actor = createActor(machine);
        let valueAtError: unknown;
        let contextAtError: { stamp: string } | undefined;
        let errorSeen: unknown;
        const errored = new Promise<void>((resolve) => {
            actor.subscribe({
                error: (err) => {
                    // Read synchronously inside the error callback — the exact
                    // site startAgent.ts:117 relies on.
                    const snap = actor.getSnapshot();
                    valueAtError = snap.value;
                    contextAtError = snap.context;
                    errorSeen = err;
                    resolve();
                },
            });
        });
        actor.start();
        actor.send({ type: "GO" });
        await errored;

        expect(errorSeen).toBe(BOOM);
        expect(valueAtError).toBe("failing");
        expect(contextAtError).toEqual({ stamp: "set" });
    });
});

// ── Behavior 3 — `getSnapshot().getMeta()` exposes active-node meta ──────
//
// SPEC: P20 row 3 — "snapshot.getMeta() exposes active-node meta" → "The
//       `awaiting` readiness signal (spec 011)" (relied on at
//       startAgent.ts:151-160; the `atlasAwaiting` channel).
//
// `getMeta()` must return a record keyed by each active state node, carrying
// the `meta` Atlas stamps on `$wait` leaves. If this stops surfacing, the
// `awaiting` readiness signal silently disappears.

describe("P20.3 — getMeta exposes active-node meta", () => {
    test("active state's meta is reachable via getSnapshot().getMeta()", () => {
        const machine = setup({
            types: { events: {} as { type: "RESUME" } },
        }).createMachine({
            id: "meta",
            initial: "waiting",
            states: {
                waiting: { meta: { atlasAwaiting: ["RESUME"] } },
            },
        });

        const actor = createActor(machine).start();
        const metaByNode = actor.getSnapshot().getMeta();
        expect(Object.values(metaByNode)).toContainEqual({
            atlasAwaiting: ["RESUME"],
        });
        actor.stop();
    });
});
