// SPEC 013 runtime verification — the `onEvent` observability stream.
//
// Builds a real compiled agent (so the `$run`/`$wait` synthesis is exercised)
// and captures the full event stream, asserting kinds, mode-paths, payloads,
// envelope stamping, and the sanitized context. This is the feasibility proof
// for the spec's §Mapping (every kind derived from the `@xstate.snapshot`
// stream).

import { describe, expect, test } from "vitest";

import { defineAgent } from "../src/defineAgent.ts";
import { defineMode } from "../src/defineMode.ts";
import { startAgent } from "../src/startAgent.ts";
import type { AgentEvent } from "../src/types.ts";

type Ctx = { log: string[] };
type Ev = { type: "MSG"; text: string };

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

// Project an event to a compact, deterministic signature (drops `at`, which is
// wall-clock). `seq` and `modePath` are kept — they are deterministic.
function sig(e: AgentEvent<Ctx>): string {
    switch (e.kind) {
        case "mode.run.settled":
            return `${e.seq} ${e.kind} ${e.modePath} ${e.outcome}`;
        case "mode.stayed":
            return `${e.seq} ${e.kind} ${e.modePath} ${e.stay}`;
        case "mode.parked":
            return `${e.seq} ${e.kind} ${e.modePath} [${e.awaiting.join(",")}]`;
        case "mode.exited":
            return `${e.seq} ${e.kind} ${e.modePath} -> ${e.to}`;
        default:
            return `${e.seq} ${e.kind} ${e.modePath}`;
    }
}

describe("spec 013 onEvent stream", () => {
    test("emits the full lifecycle for passive→active→park→resume", async () => {
        // PASSIVE: parks on entry, runs on MSG.
        const idle = defineMode<Ctx, Ev, { text: string }>({
            start: "event",
            events: ["MSG"],
            input: ({ context }) => ({ log: context.log }),
            behavior: async ({ event }) => ({ outcome: "achieved", payload: { text: event.text } }),
            routes: {
                achieved: {
                    target: "work",
                    assign: ({ context, payload }) => ({ log: [...context.log, `got:${payload.text}`] }),
                },
                abandoned: { target: "work" },
            },
        });

        // ACTIVE: dry-run parks via waitOnEvent; next MSG resumes and achieves.
        const work = defineMode<Ctx, Ev, { done: boolean }>({
            events: ["MSG"],
            input: ({ context }) => ({ log: context.log }),
            behavior: async ({ event }) => {
                if (event?.type === "MSG") return { outcome: "achieved", payload: { done: true } };
                return { stay: "waitOnEvent", payload: { done: false } };
            },
            routes: {
                achieved: { target: "idle", assign: ({ context }) => ({ log: [...context.log, "work-done"] }) },
                abandoned: { target: "idle" },
            },
            stay: { waitOnEvent: {} },
        });

        const machine = defineAgent<Ctx, Ev, { idle: typeof idle; work: typeof work }>({
            id: "smoke",
            initial: "idle",
            context: { log: [] },
            events: {} as Ev,
            modes: { idle, work },
        });

        const events: AgentEvent<Ctx>[] = [];
        const actor = startAgent<Ctx, Ev>(machine, {
            correlationId: "trace-1",
            onEvent: (e) => events.push(e),
        });

        await flush(); // boot: idle is passive → parks
        actor.send({ type: "MSG", text: "a" });
        await flush();
        actor.send({ type: "MSG", text: "b" });
        await flush();
        actor.stop();

        // ── Envelope invariants ──
        expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i)); // monotonic 0..n
        expect(events.every((e) => e.correlationId === "trace-1")).toBe(true);
        expect(events.every((e) => typeof e.at === "number")).toBe(true);

        // ── Context sanitized: no `$event` / `__*_local` keys ──
        for (const e of events) {
            const keys = Object.keys(e.context as Record<string, unknown>);
            expect(keys).not.toContain("$event");
            expect(keys.some((k) => /^__.*_local$/.test(k))).toBe(false);
        }

        // ── Key milestones present, in order ──
        const kinds = events.map((e) => `${e.kind}:${e.modePath}`);
        expect(kinds[0]).toBe("mode.entered:idle");
        expect(kinds).toContain("mode.parked:idle");
        expect(kinds).toContain("mode.run.started:idle");
        expect(kinds).toContain("mode.run.settled:idle");
        expect(kinds).toContain("mode.exited:idle");
        expect(kinds).toContain("mode.entered:work");
        expect(kinds).toContain("mode.stayed:work");

        // ── run.settled carries outcome + payload ──
        const idleSettled = events.find(
            (e): e is Extract<AgentEvent<Ctx>, { kind: "mode.run.settled" }> =>
                e.kind === "mode.run.settled" && e.modePath === "idle",
        );
        expect(idleSettled?.outcome).toBe("achieved");
        expect(idleSettled?.payload).toEqual({ text: "a" });
        expect(typeof idleSettled?.durationMs).toBe("number");

        // ── no duplicate consecutive events (parked dedup) ──
        const sigs = events.map(sig).map((s) => s.replace(/^\d+ /, ""));
        for (let i = 1; i < sigs.length; i += 1) {
            expect(sigs[i]).not.toBe(sigs[i - 1]);
        }

        // ── trigger captured on the resuming run ──
        const idleRun = events.find(
            (e): e is Extract<AgentEvent<Ctx>, { kind: "mode.run.started" }> =>
                e.kind === "mode.run.started" && e.modePath === "idle",
        );
        expect(idleRun?.trigger).toEqual({ type: "MSG" });
    });
});
