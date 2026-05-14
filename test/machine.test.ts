import { describe, it, expect, vi } from "vitest";
import { createActor, fromPromise } from "xstate";

// Prevent OpenAI client instantiation at module level (no API key in tests).
// The mock chat() is never called — actors are replaced via machine.provide().
vi.mock("../src/llm-client.js", () => ({ chat: vi.fn() }));

import { agentMachine } from "../src/machine.js";
import type { Message } from "../src/llm-client.js";

// ── Helpers ──────────────────────────────────────────────────────────

function createTestActor(options: {
    greetingsResult: { greeting: string; needsFollowUp: boolean };
    improviseResults: Message[][];
}) {
    let improviseCallIndex = 0;

    const testMachine = agentMachine.provide({
        actors: {
            greetingsNode: fromPromise<
                { greeting: string; needsFollowUp: boolean },
                { messages: Message[] }
            >(async () => options.greetingsResult),
            improviseThinkingNode: fromPromise<Message[], { messages: Message[] }>(async () => {
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
            improviseResults: [
                [{ role: "assistant", content: "Brasília." }],
            ],
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
            improviseResults: [
                [{ role: "assistant", content: "Brasília." }],
            ],
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
            improviseResults: [
                [{ role: "assistant", content: "Brasília." }],
                [{ role: "assistant", content: "Cerca de 200 milhões." }],
            ],
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

    it("handles single tool call in improvise", async () => {
        const actor = createTestActor({
            greetingsResult: {
                greeting: "Olá! Sou Atlas.",
                needsFollowUp: false,
            },
            improviseResults: [
                [
                    { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function" as const, function: { name: "get_current_time", arguments: "{}" } }] },
                    { role: "tool", content: "2026-05-14T10:30:00Z", tool_call_id: "call_1" },
                    { role: "assistant", content: "São 10:30 da manhã!" },
                ],
            ],
        });

        actor.send({ type: "MESSAGE", text: "oi" });
        await waitForReady(actor);

        actor.send({ type: "MESSAGE", text: "que horas são?" });
        await waitForReady(actor);

        const snapshot = actor.getSnapshot();
        expect(snapshot.matches({ improvise: "listening" })).toBe(true);
        expect(snapshot.context.messages).toEqual([
            { role: "user", content: "oi" },
            { role: "assistant", content: "Olá! Sou Atlas." },
            { role: "user", content: "que horas são?" },
            { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_current_time", arguments: "{}" } }] },
            { role: "tool", content: "2026-05-14T10:30:00Z", tool_call_id: "call_1" },
            { role: "assistant", content: "São 10:30 da manhã!" },
        ]);

        actor.stop();
    });

    it("handles multi-step tool calls in improvise", async () => {
        const actor = createTestActor({
            greetingsResult: {
                greeting: "Olá! Sou Atlas.",
                needsFollowUp: false,
            },
            improviseResults: [
                [
                    { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function" as const, function: { name: "get_current_time", arguments: "{}" } }] },
                    { role: "tool", content: "2026-05-14T10:30:00Z", tool_call_id: "call_1" },
                    { role: "assistant", content: null, tool_calls: [{ id: "call_2", type: "function" as const, function: { name: "get_current_time", arguments: "{}" } }] },
                    { role: "tool", content: "2026-05-14T10:30:01Z", tool_call_id: "call_2" },
                    { role: "assistant", content: "Confirmei duas vezes: são 10:30." },
                ],
            ],
        });

        actor.send({ type: "MESSAGE", text: "oi" });
        await waitForReady(actor);

        actor.send({ type: "MESSAGE", text: "que horas são? confira duas vezes" });
        await waitForReady(actor);

        const snapshot = actor.getSnapshot();
        expect(snapshot.matches({ improvise: "listening" })).toBe(true);
        expect(snapshot.context.messages).toEqual([
            { role: "user", content: "oi" },
            { role: "assistant", content: "Olá! Sou Atlas." },
            { role: "user", content: "que horas são? confira duas vezes" },
            { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_current_time", arguments: "{}" } }] },
            { role: "tool", content: "2026-05-14T10:30:00Z", tool_call_id: "call_1" },
            { role: "assistant", content: null, tool_calls: [{ id: "call_2", type: "function", function: { name: "get_current_time", arguments: "{}" } }] },
            { role: "tool", content: "2026-05-14T10:30:01Z", tool_call_id: "call_2" },
            { role: "assistant", content: "Confirmei duas vezes: são 10:30." },
        ]);

        actor.stop();
    });

    it("preserves tool messages in context across user turns", async () => {
        const actor = createTestActor({
            greetingsResult: {
                greeting: "Olá! Sou Atlas.",
                needsFollowUp: false,
            },
            improviseResults: [
                [
                    { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function" as const, function: { name: "get_current_time", arguments: "{}" } }] },
                    { role: "tool", content: "2026-05-14T10:30:00Z", tool_call_id: "call_1" },
                    { role: "assistant", content: "São 10:30 da manhã!" },
                ],
                [
                    { role: "assistant", content: "Em Tóquio são 00:30 do dia seguinte." },
                ],
            ],
        });

        actor.send({ type: "MESSAGE", text: "oi" });
        await waitForReady(actor);

        actor.send({ type: "MESSAGE", text: "que horas são?" });
        await waitForReady(actor);

        actor.send({ type: "MESSAGE", text: "e em Tóquio?" });
        await waitForReady(actor);

        const snapshot = actor.getSnapshot();
        expect(snapshot.context.messages).toEqual([
            { role: "user", content: "oi" },
            { role: "assistant", content: "Olá! Sou Atlas." },
            { role: "user", content: "que horas são?" },
            { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_current_time", arguments: "{}" } }] },
            { role: "tool", content: "2026-05-14T10:30:00Z", tool_call_id: "call_1" },
            { role: "assistant", content: "São 10:30 da manhã!" },
            { role: "user", content: "e em Tóquio?" },
            { role: "assistant", content: "Em Tóquio são 00:30 do dia seguinte." },
        ]);

        actor.stop();
    });
});
