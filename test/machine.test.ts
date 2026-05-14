import { describe, it, expect, vi } from "vitest";
import { createActor, fromPromise } from "xstate";

// Prevent OpenAI client instantiation at module level (no API key in tests).
// The mock chat() is never called — actors are replaced via machine.provide().
vi.mock("../src/openrouter.js", () => ({ chat: vi.fn() }));

import { agentMachine, type LLMInput } from "../src/machine.js";

// ── Helpers ──────────────────────────────────────────────────────────

function createTestActor(options: {
    greetingsResult: { greeting: string; needsFollowUp: boolean };
    improviseResults: string[];
}) {
    let improviseCallIndex = 0;

    const testMachine = agentMachine.provide({
        actors: {
            greetingsNode: fromPromise<
                { greeting: string; needsFollowUp: boolean },
                LLMInput
            >(async () => options.greetingsResult),
            improviseThinkingNode: fromPromise<string, LLMInput>(async () => {
                const result =
                    options.improviseResults[improviseCallIndex] ??
                    options.improviseResults[options.improviseResults.length - 1];
                improviseCallIndex++;
                return result;
            }),
        },
    });

    const actor = createActor(testMachine);
    actor.start();
    return actor;
}

function waitForReady(
    actor: ReturnType<typeof createTestActor>
): Promise<void> {
    return new Promise((resolve) => {
        if (actor.getSnapshot().can({ type: "MESSAGE", text: "" })) {
            resolve();
            return;
        }
        const sub = actor.subscribe((snapshot) => {
            if (snapshot.can({ type: "MESSAGE", text: "" })) {
                sub.unsubscribe();
                resolve();
            }
        });
    });
}

// ── Tests ────────────────────────────────────────────────────────────

describe("agentMachine", () => {
    it("handles simple greeting then separate question", async () => {
        const actor = createTestActor({
            greetingsResult: {
                greeting: "Olá! Sou Atlas.",
                needsFollowUp: false,
            },
            improviseResults: ["Brasília."],
        });

        actor.send({ type: "MESSAGE", text: "oi" });
        await waitForReady(actor);

        let snapshot = actor.getSnapshot();
        expect(snapshot.matches({ improvise: "listening" })).toBe(true);
        expect(snapshot.context.messages).toEqual([
            { role: "user", content: "oi" },
            { role: "assistant", content: "Olá! Sou Atlas." },
        ]);

        actor.send({ type: "MESSAGE", text: "qual a capital do Brasil?" });
        await waitForReady(actor);

        snapshot = actor.getSnapshot();
        expect(snapshot.matches({ improvise: "listening" })).toBe(true);
        expect(snapshot.context.messages).toEqual([
            { role: "user", content: "oi" },
            { role: "assistant", content: "Olá! Sou Atlas." },
            { role: "user", content: "qual a capital do Brasil?" },
            { role: "assistant", content: "Brasília." },
        ]);

        actor.stop();
    });

    it("handles greeting with follow-up in the same message (PARTIALLY_RESPONDED)", async () => {
        const actor = createTestActor({
            greetingsResult: {
                greeting: "Olá! Sou Atlas.",
                needsFollowUp: true,
            },
            improviseResults: ["Brasília."],
        });

        actor.send({
            type: "MESSAGE",
            text: "oi, qual a capital do Brasil?",
        });
        await waitForReady(actor);

        const snapshot = actor.getSnapshot();
        expect(snapshot.matches({ improvise: "listening" })).toBe(true);
        expect(snapshot.context.messages).toEqual([
            { role: "user", content: "oi, qual a capital do Brasil?" },
            { role: "assistant", content: "Olá! Sou Atlas." },
            { role: "assistant", content: "Brasília." },
        ]);

        actor.stop();
    });

    it("handles greeting with follow-up then additional question", async () => {
        const actor = createTestActor({
            greetingsResult: {
                greeting: "Olá! Sou Atlas.",
                needsFollowUp: true,
            },
            improviseResults: ["Brasília.", "Cerca de 200 milhões."],
        });

        actor.send({
            type: "MESSAGE",
            text: "oi, qual a capital do Brasil?",
        });
        await waitForReady(actor);

        let snapshot = actor.getSnapshot();
        expect(snapshot.matches({ improvise: "listening" })).toBe(true);
        expect(snapshot.context.messages).toEqual([
            { role: "user", content: "oi, qual a capital do Brasil?" },
            { role: "assistant", content: "Olá! Sou Atlas." },
            { role: "assistant", content: "Brasília." },
        ]);

        actor.send({ type: "MESSAGE", text: "e a população?" });
        await waitForReady(actor);

        snapshot = actor.getSnapshot();
        expect(snapshot.matches({ improvise: "listening" })).toBe(true);
        expect(snapshot.context.messages).toEqual([
            { role: "user", content: "oi, qual a capital do Brasil?" },
            { role: "assistant", content: "Olá! Sou Atlas." },
            { role: "assistant", content: "Brasília." },
            { role: "user", content: "e a população?" },
            { role: "assistant", content: "Cerca de 200 milhões." },
        ]);

        actor.stop();
    });
});
