// SPEC 011 runtime smoke test — exercises the unified-mode lowering end to end:
// passive entry (parks, no dry run), event delivery via the $event slot, an
// active dry run, `stay: "waitOnEvent"` parking, and achieved → target routing.
//
// We assert on the resulting context (`log`) rather than synthetic paths, so the
// test is robust to how $run/$wait are masked in inspect.

import { describe, expect, test } from "vitest";

import { defineAgent } from "../src/defineAgent.ts";
import { defineMode } from "../src/defineMode.ts";
import { startAgent } from "../src/startAgent.ts";
import type { AgentInspectionEvent } from "../src/types.ts";

type Ctx = { log: string[] };
type Ev = { type: "MSG"; text: string };

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("spec 011 lowering", () => {
    test("passive entry → event → active dry-run → waitOnEvent → resume", async () => {
        // PASSIVE: parks on entry; runs only when MSG arrives (event: Ev, no guard).
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

        // ACTIVE (default): dry-run entry parks via waitOnEvent; the next MSG resumes it.
        const work = defineMode<Ctx, Ev, { done: boolean }>({
            events: ["MSG"],
            input: ({ context }) => ({ log: context.log }),
            behavior: async ({ event }) => {
                if (event?.type === "MSG") return { outcome: "achieved", payload: { done: true } };
                return { stay: "waitOnEvent", payload: { done: false } }; // dry-run -> park
            },
            routes: {
                achieved: {
                    target: "idle",
                    assign: ({ context }) => ({ log: [...context.log, "work-done"] }),
                },
                abandoned: { target: "idle" },
            },
            stay: {
                waitOnEvent: { assign: ({ context }) => ({ log: [...context.log, "work-parked"] }) },
            },
        });

        const machine = defineAgent<Ctx, Ev, { idle: typeof idle; work: typeof work }>({
            id: "smoke",
            initial: "idle",
            context: { log: [] },
            events: {} as Ev,
            modes: { idle, work },
        });

        let lastContext: Ctx = { log: [] };
        const actor = startAgent<Ctx, Ev>(machine, {
            inspect: (e: AgentInspectionEvent<Ctx>) => {
                lastContext = e.context;
            },
        });

        await flush();
        // passive idle parked — nothing ran yet
        expect(lastContext.log).toEqual([]);

        actor.send({ type: "MSG", text: "a" });
        await flush();
        actor.send({ type: "MSG", text: "b" });
        await flush();

        // idle(MSG a)->achieved got:a -> work dry-run -> waitOnEvent work-parked
        //   -> work(MSG b)->achieved work-done -> idle parks
        expect(lastContext.log).toEqual(["got:a", "work-parked", "work-done"]);

        actor.stop();
    });
});
