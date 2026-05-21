import { describe, it, expect, vi } from "vitest";
import { createActor, fromPromise } from "xstate";

// Prevent OpenAI client instantiation at module level (no API key in tests).
// The mock chat() is never called — actors are replaced via machine.provide().
vi.mock("../src/llm-client.js", () => ({ chat: vi.fn() }));

import { agentMachine } from "../src/machine.js";
import type { Message } from "../src/llm-client.js";
import type { ModeOutput } from "../src/types.js";

// ── Helpers ──────────────────────────────────────────────────────────

type ClassifyResult = ModeOutput<{ intent: "greetings" | "socratic" | "improvise" | "none" }>;
type MessagesResult = ModeOutput<{ messages: Message[] }>;
type EvaluatingResult = ModeOutput<{ result: "achieved" | "retry" | "abandoned" }>;

function createTestActor(options: {
    classifyResults: ClassifyResult[];
    greetingsResults?: MessagesResult[];
    socraticTeachingResults?: MessagesResult[];
    socraticEvaluatingResults?: EvaluatingResult[];
    improvisingResults?: MessagesResult[];
}) {
    let classifyIndex = 0;
    let greetingsIndex = 0;
    let socraticTeachingIndex = 0;
    let socraticEvaluatingIndex = 0;
    let improvisingIndex = 0;

    // Actor names follow DD-008: `<camelCase(path)>Node`, produced by
    // packages/atlas/src/actorName.ts. `listening` is passive (no actor).
    const testMachine = agentMachine.provide({
        actors: {
            classifyingNode: fromPromise<ClassifyResult, { messages: Message[] }>(async () => {
                const result =
                    options.classifyResults[classifyIndex] ??
                    options.classifyResults[options.classifyResults.length - 1];
                classifyIndex++;
                return result;
            }),
            greetingsThinkingNode: fromPromise<MessagesResult, { messages: Message[] }>(async () => {
                const results = options.greetingsResults ?? [];
                const result = results[greetingsIndex] ?? results[results.length - 1];
                greetingsIndex++;
                return result;
            }),
            socraticTeachingNode: fromPromise<MessagesResult, { messages: Message[] }>(async () => {
                const results = options.socraticTeachingResults ?? [];
                const result = results[socraticTeachingIndex] ?? results[results.length - 1];
                socraticTeachingIndex++;
                return result;
            }),
            socraticEvaluatingNode: fromPromise<EvaluatingResult, { messages: Message[] }>(async () => {
                const results = options.socraticEvaluatingResults ?? [];
                const result = results[socraticEvaluatingIndex] ?? results[results.length - 1];
                socraticEvaluatingIndex++;
                return result;
            }),
            improvisingThinkingNode: fromPromise<MessagesResult, { messages: Message[] }>(async () => {
                const results = options.improvisingResults ?? [];
                const result = results[improvisingIndex] ?? results[results.length - 1];
                improvisingIndex++;
                return result;
            }),
        },
    });

    const actor = createActor(testMachine);
    actor.start();
    return actor;
}

function waitForState(
    actor: ReturnType<typeof createTestActor>,
    predicate: (snapshot: ReturnType<ReturnType<typeof createTestActor>["getSnapshot"]>) => boolean
): Promise<void> {
    return new Promise((resolve) => {
        if (predicate(actor.getSnapshot())) {
            resolve();
            return;
        }
        const sub = actor.subscribe((snapshot) => {
            if (predicate(snapshot)) {
                sub.unsubscribe();
                resolve();
            }
        });
    });
}

function waitForReady(actor: ReturnType<typeof createTestActor>): Promise<void> {
    return waitForState(actor, (s) => s.can({ type: "MESSAGE", text: "" }));
}

// ── Tests ────────────────────────────────────────────────────────────

describe("agentMachine", () => {
    it("handles simple greeting then question", async () => {
        const actor = createTestActor({
            classifyResults: [
                { outcome: "achieved", payload: { intent: "greetings" } },
                { outcome: "achieved", payload: { intent: "none" } },
                { outcome: "achieved", payload: { intent: "improvise" } },
                { outcome: "achieved", payload: { intent: "none" } },
            ],
            greetingsResults: [
                { outcome: "achieved", payload: { messages: [{ role: "assistant", content: "Ola! Sou Zoe." }] } },
            ],
            improvisingResults: [
                { outcome: "achieved", payload: { messages: [{ role: "assistant", content: "Brasilia." }] } },
            ],
        });

        // First message → classifying (greetings) → greetings → classifying (none) → listening
        actor.send({ type: "MESSAGE", text: "oi" });
        await waitForReady(actor);

        let snapshot = actor.getSnapshot();
        expect(snapshot.matches("listening")).toBe(true);
        expect(snapshot.context.messages).toEqual([
            { role: "user", content: "oi" },
            { role: "assistant", content: "Ola! Sou Zoe." },
        ]);

        // Second message → classifying (improvise) → improvising → classifying (none) → listening
        actor.send({ type: "MESSAGE", text: "qual a capital do Brasil?" });
        await waitForReady(actor);

        snapshot = actor.getSnapshot();
        expect(snapshot.matches("listening")).toBe(true);
        expect(snapshot.context.messages).toEqual([
            { role: "user", content: "oi" },
            { role: "assistant", content: "Ola! Sou Zoe." },
            { role: "user", content: "qual a capital do Brasil?" },
            { role: "assistant", content: "Brasilia." },
        ]);

        actor.stop();
    });

    it("handles greeting with follow-up routed to socratic", async () => {
        const actor = createTestActor({
            classifyResults: [
                { outcome: "achieved", payload: { intent: "greetings" } },
                { outcome: "achieved", payload: { intent: "socratic" } },
                // After socratic done:
                { outcome: "achieved", payload: { intent: "none" } },
            ],
            greetingsResults: [
                { outcome: "achieved", payload: { messages: [{ role: "assistant", content: "Ola! Sou Zoe." }] } },
            ],
            socraticTeachingResults: [
                { outcome: "achieved", payload: { messages: [{ role: "assistant", content: "Closures sao funcoes que capturam variaveis. O que acontece com a variavel x apos retornar a funcao interna?" }] } },
            ],
            socraticEvaluatingResults: [
                { outcome: "achieved", payload: { result: "achieved" } },
            ],
        });

        // "oi, me explica closures" → greetings → classifier detects socratic → socratic teaches
        actor.send({ type: "MESSAGE", text: "oi, me explica closures" });
        // Wait for socratic.listening (where MESSAGE is accepted)
        await waitForReady(actor);

        let snapshot = actor.getSnapshot();
        expect(snapshot.matches({ socratic: "listening" })).toBe(true);
        expect(snapshot.context.messages).toEqual([
            { role: "user", content: "oi, me explica closures" },
            { role: "assistant", content: "Ola! Sou Zoe." },
            { role: "assistant", content: "Closures sao funcoes que capturam variaveis. O que acontece com a variavel x apos retornar a funcao interna?" },
        ]);

        // User answers correctly → evaluating (achieved, analytical-only) → done → classifying (none) → listening
        actor.send({ type: "MESSAGE", text: "a variavel x continua acessivel pela funcao interna" });
        await waitForReady(actor);

        snapshot = actor.getSnapshot();
        expect(snapshot.matches("listening")).toBe(true);
        expect(snapshot.context.messages).toEqual([
            { role: "user", content: "oi, me explica closures" },
            { role: "assistant", content: "Ola! Sou Zoe." },
            { role: "assistant", content: "Closures sao funcoes que capturam variaveis. O que acontece com a variavel x apos retornar a funcao interna?" },
            { role: "user", content: "a variavel x continua acessivel pela funcao interna" },
        ]);

        actor.stop();
    });

    it("handles socratic pass (direct, no greeting)", async () => {
        const actor = createTestActor({
            classifyResults: [
                { outcome: "achieved", payload: { intent: "socratic" } },
                { outcome: "achieved", payload: { intent: "none" } },
            ],
            socraticTeachingResults: [
                { outcome: "achieved", payload: { messages: [{ role: "assistant", content: "Closures explicados. Pergunta: o que acontece com x?" }] } },
            ],
            socraticEvaluatingResults: [
                { outcome: "achieved", payload: { result: "achieved" } },
            ],
        });

        actor.send({ type: "MESSAGE", text: "me explica closures" });
        await waitForReady(actor);

        let snapshot = actor.getSnapshot();
        expect(snapshot.matches({ socratic: "listening" })).toBe(true);

        actor.send({ type: "MESSAGE", text: "resposta correta" });
        await waitForReady(actor);

        snapshot = actor.getSnapshot();
        expect(snapshot.matches("listening")).toBe(true);
        expect(snapshot.context.messages).toEqual([
            { role: "user", content: "me explica closures" },
            { role: "assistant", content: "Closures explicados. Pergunta: o que acontece com x?" },
            { role: "user", content: "resposta correta" },
        ]);

        actor.stop();
    });

    it("handles socratic retry then pass", async () => {
        const actor = createTestActor({
            classifyResults: [
                { outcome: "achieved", payload: { intent: "socratic" } },
                { outcome: "achieved", payload: { intent: "none" } },
            ],
            socraticTeachingResults: [
                { outcome: "achieved", payload: { messages: [{ role: "assistant", content: "Explicacao inicial. Pergunta?" }] } },
                { outcome: "achieved", payload: { messages: [{ role: "assistant", content: "Explicacao revisada. Tente novamente?" }] } },
            ],
            socraticEvaluatingResults: [
                { outcome: "achieved", payload: { result: "retry" } },
                { outcome: "achieved", payload: { result: "achieved" } },
            ],
        });

        actor.send({ type: "MESSAGE", text: "me explica closures" });
        await waitForReady(actor);

        // First attempt — wrong answer
        actor.send({ type: "MESSAGE", text: "nao sei" });
        // retry → teaching again → listening
        await waitForReady(actor);

        let snapshot = actor.getSnapshot();
        expect(snapshot.matches({ socratic: "listening" })).toBe(true);

        // Second attempt — correct answer
        actor.send({ type: "MESSAGE", text: "agora eu sei" });
        await waitForReady(actor);

        snapshot = actor.getSnapshot();
        expect(snapshot.matches("listening")).toBe(true);
        expect(snapshot.context.messages).toEqual([
            { role: "user", content: "me explica closures" },
            { role: "assistant", content: "Explicacao inicial. Pergunta?" },
            { role: "user", content: "nao sei" },
            { role: "assistant", content: "Explicacao revisada. Tente novamente?" },
            { role: "user", content: "agora eu sei" },
        ]);

        actor.stop();
    });

    it("handles socratic abandonment", async () => {
        const actor = createTestActor({
            classifyResults: [
                { outcome: "achieved", payload: { intent: "socratic" } },
                // After abandoned, classifier routes the new intent
                { outcome: "achieved", payload: { intent: "improvise" } },
                { outcome: "achieved", payload: { intent: "none" } },
            ],
            socraticTeachingResults: [
                { outcome: "achieved", payload: { messages: [{ role: "assistant", content: "Explicacao. Pergunta?" }] } },
            ],
            socraticEvaluatingResults: [
                { outcome: "achieved", payload: { result: "abandoned" } },
            ],
            improvisingResults: [
                { outcome: "achieved", payload: { messages: [{ role: "assistant", content: "Sao 10:30." }] } },
            ],
        });

        actor.send({ type: "MESSAGE", text: "me explica closures" });
        await waitForReady(actor);

        // User abandons and asks a different question
        actor.send({ type: "MESSAGE", text: "para, me diz que horas sao" });
        // abandoned → done → classifying → improvise → improvising → done → classifying (none) → listening
        await waitForReady(actor);

        const snapshot = actor.getSnapshot();
        expect(snapshot.matches("listening")).toBe(true);
        expect(snapshot.context.messages).toEqual([
            { role: "user", content: "me explica closures" },
            { role: "assistant", content: "Explicacao. Pergunta?" },
            { role: "user", content: "para, me diz que horas sao" },
            { role: "assistant", content: "Sao 10:30." },
        ]);

        actor.stop();
    });

    it("handles improvising with tool messages", async () => {
        const actor = createTestActor({
            classifyResults: [
                { outcome: "achieved", payload: { intent: "improvise" } },
                { outcome: "achieved", payload: { intent: "none" } },
            ],
            improvisingResults: [
                { outcome: "achieved", payload: { messages: [
                    { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function" as const, function: { name: "get_current_time", arguments: "{}" } }] },
                    { role: "tool", content: "2026-05-14T10:30:00Z", tool_call_id: "call_1" },
                    { role: "assistant", content: "Sao 10:30 da manha!" },
                ] } },
            ],
        });

        actor.send({ type: "MESSAGE", text: "que horas sao?" });
        await waitForReady(actor);

        const snapshot = actor.getSnapshot();
        expect(snapshot.matches("listening")).toBe(true);
        expect(snapshot.context.messages).toEqual([
            { role: "user", content: "que horas sao?" },
            { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_current_time", arguments: "{}" } }] },
            { role: "tool", content: "2026-05-14T10:30:00Z", tool_call_id: "call_1" },
            { role: "assistant", content: "Sao 10:30 da manha!" },
        ]);

        actor.stop();
    });

    it("handles multiple turns — greeting then improvise then improvise", async () => {
        const actor = createTestActor({
            classifyResults: [
                { outcome: "achieved", payload: { intent: "greetings" } },
                { outcome: "achieved", payload: { intent: "none" } },
                { outcome: "achieved", payload: { intent: "improvise" } },
                { outcome: "achieved", payload: { intent: "none" } },
                { outcome: "achieved", payload: { intent: "improvise" } },
                { outcome: "achieved", payload: { intent: "none" } },
            ],
            greetingsResults: [
                { outcome: "achieved", payload: { messages: [{ role: "assistant", content: "Ola! Sou Zoe." }] } },
            ],
            improvisingResults: [
                { outcome: "achieved", payload: { messages: [{ role: "assistant", content: "Brasilia." }] } },
                { outcome: "achieved", payload: { messages: [{ role: "assistant", content: "Cerca de 200 milhoes." }] } },
            ],
        });

        actor.send({ type: "MESSAGE", text: "oi" });
        await waitForReady(actor);

        actor.send({ type: "MESSAGE", text: "capital do Brasil?" });
        await waitForReady(actor);

        actor.send({ type: "MESSAGE", text: "e a populacao?" });
        await waitForReady(actor);

        const snapshot = actor.getSnapshot();
        expect(snapshot.matches("listening")).toBe(true);
        expect(snapshot.context.messages).toEqual([
            { role: "user", content: "oi" },
            { role: "assistant", content: "Ola! Sou Zoe." },
            { role: "user", content: "capital do Brasil?" },
            { role: "assistant", content: "Brasilia." },
            { role: "user", content: "e a populacao?" },
            { role: "assistant", content: "Cerca de 200 milhoes." },
        ]);

        actor.stop();
    });
});
