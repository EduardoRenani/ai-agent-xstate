import { describe, it, expect, vi } from "vitest";
import { createActor, fromPromise } from "xstate";

// Prevent OpenAI client instantiation at module level (no API key in tests).
// The mock chat() is never called — actors are replaced via machine.provide().
vi.mock("../src/llm-client.js", () => ({ chat: vi.fn() }));

import { agentMachine } from "../src/machine.js";
import { chat } from "../src/llm-client.js";
import type { Message } from "../src/llm-client.js";
import type { ModeOutput } from "../src/types.js";

// ── Helpers ──────────────────────────────────────────────────────────

type ClassifyResult = ModeOutput<{ intent: "greetings" | "socratic" | "improvise" | "none" }>;
type MessagesResult = ModeOutput<{ messages: Message[] }>;
// Spec 003 §`socratic.evaluating`: the actor maps the model's judgment to
// one of three outcomes (achieved / retry / abandoned) and ships
// `{ understood: boolean }` as the payload. Tests speak the same shape.
type EvaluatingResult = ModeOutput<{ understood: boolean }>;

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
            greetingsNode: fromPromise<MessagesResult, { messages: Message[] }>(async () => {
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
            improvisingNode: fromPromise<MessagesResult, { messages: Message[] }>(async () => {
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
                { outcome: "achieved", payload: { understood: true } },
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
                { outcome: "achieved", payload: { understood: true } },
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
                // Spec 003: "not_understood" → achieved + understood: false
                // → guard routes back to teaching (no wrapper retry needed
                // when the LLM produced a parseable judgment).
                { outcome: "achieved", payload: { understood: false } },
                { outcome: "achieved", payload: { understood: true } },
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

    it("retry assign increments the socratic-local evalRetries counter", async () => {
        const actor = createTestActor({
            classifyResults: [
                { outcome: "achieved", payload: { intent: "socratic" } },
                { outcome: "achieved", payload: { intent: "none" } },
            ],
            socraticTeachingResults: [
                { outcome: "achieved", payload: { messages: [{ role: "assistant", content: "Explicacao. Pergunta?" }] } },
            ],
            socraticEvaluatingResults: [
                // Two unusable judgments → wrapper retry self-loops the leaf,
                // each running the compound-local `assign` before re-invoking
                // behavior; the third pass exits the compound.
                { outcome: "retry", payload: { understood: false } },
                { outcome: "retry", payload: { understood: false } },
                { outcome: "achieved", payload: { understood: true } },
            ],
        });

        // The local slot is wiped when socratic exits (DD-018), so capture the
        // peak counter live via the subscription.
        const slotKey = "__socratic_local";
        let peakRetries = 0;
        actor.subscribe((snapshot) => {
            const slot = (snapshot.context as Record<string, unknown>)[slotKey];
            if (slot !== null && typeof slot === "object") {
                const n = (slot as { evalRetries?: number }).evalRetries ?? 0;
                if (n > peakRetries) peakRetries = n;
            }
        });

        actor.send({ type: "MESSAGE", text: "me explica closures" });
        await waitForReady(actor);

        // One reply enters evaluating; the two retry outcomes self-loop the
        // leaf (no listening in between) before the pass exits the compound.
        actor.send({ type: "MESSAGE", text: "hmm" });
        await waitForReady(actor);

        const snapshot = actor.getSnapshot();
        expect(snapshot.matches("listening")).toBe(true);
        expect(peakRetries).toBe(2);
        // Compound exit cleared the local slot; the global context never carried it.
        expect((snapshot.context as Record<string, unknown>)[slotKey]).toBeUndefined();
        expect((snapshot.context as Record<string, unknown>).evalRetries).toBeUndefined();

        actor.stop();
    });

    it("circuit-breaks the socratic retry loop once evalRetries hits the limit", async () => {
        // Unlike the other tests, this one runs the REAL `socraticEvaluating`
        // behavior (the actor is intentionally NOT stubbed) so the
        // circuit-breaker actually executes. chat() returns unparseable
        // content → judgment "unknown" → wrapper retry while under the cap,
        // then `abandoned` once the compound-local evalRetries reaches 3.
        vi.mocked(chat).mockResolvedValue([{ role: "assistant", content: "isto nao e json valido" }]);

        let classifyIndex = 0;
        const classifyResults: ClassifyResult[] = [
            { outcome: "achieved", payload: { intent: "socratic" } },
            // After the breaker abandons, the compound exits to classifying.
            { outcome: "achieved", payload: { intent: "none" } },
        ];
        const testMachine = agentMachine.provide({
            actors: {
                classifyingNode: fromPromise<ClassifyResult, { messages: Message[] }>(async () => {
                    const r = classifyResults[classifyIndex] ?? classifyResults[classifyResults.length - 1];
                    classifyIndex++;
                    return r;
                }),
                socraticTeachingNode: fromPromise<MessagesResult, { messages: Message[] }>(async () => ({
                    outcome: "achieved",
                    payload: { messages: [{ role: "assistant", content: "Explicacao. Pergunta?" }] },
                })),
                // socraticEvaluatingNode left real on purpose.
            },
        });
        const actor = createActor(testMachine);
        actor.start();

        const slotKey = "__socratic_local";
        let peakRetries = 0;
        actor.subscribe((snapshot) => {
            const slot = (snapshot.context as Record<string, unknown>)[slotKey];
            if (slot !== null && typeof slot === "object") {
                const n = (slot as { evalRetries?: number }).evalRetries ?? 0;
                if (n > peakRetries) peakRetries = n;
            }
        });

        actor.send({ type: "MESSAGE", text: "me explica closures" });
        await waitForReady(actor);

        // The reply enters evaluating; the real behavior self-loops the leaf
        // three times (bumping evalRetries to 3) and then bails via abandoned.
        actor.send({ type: "MESSAGE", text: "hmm sei la" });
        await waitForReady(actor);

        const snapshot = actor.getSnapshot();
        expect(snapshot.matches("listening")).toBe(true);
        // 3 retries bring evalRetries to RETRY_LIMIT; the 4th evaluation reads
        // 3 >= 3 and abandons instead of retrying forever.
        expect(peakRetries).toBe(3);
        // Compound exit cleared the local slot; global context never carried it.
        expect((snapshot.context as Record<string, unknown>)[slotKey]).toBeUndefined();

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
                // Spec 003: "abandoned" judgment → abandoned bucket (not
                // encoded in the payload anymore — spec 008 lets the
                // compound route through the real bucket).
                { outcome: "abandoned", payload: { understood: false } },
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

    it("recovers to listening when improvising's chat() throws (error route logs, no crash)", async () => {
        // Run the REAL improvising behavior (actor NOT stubbed) so the error
        // route executes. chat() rejects → invoke onError → the leaf's
        // `error` route logs and routes to the sibling `classifying`, which
        // idles to `listening`. Pre-flatten this re-threw above the compound
        // and dropped the log (DD-026); reaching `listening` proves recovery.
        vi.mocked(chat).mockRejectedValue(new Error("LLM transport boom"));
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

        let classifyIndex = 0;
        const classifyResults: ClassifyResult[] = [
            { outcome: "achieved", payload: { intent: "improvise" } },
            { outcome: "achieved", payload: { intent: "none" } },
        ];
        const testMachine = agentMachine.provide({
            actors: {
                classifyingNode: fromPromise<ClassifyResult, { messages: Message[] }>(async () => {
                    const r = classifyResults[classifyIndex] ?? classifyResults[classifyResults.length - 1];
                    classifyIndex++;
                    return r;
                }),
                // improvisingNode left real on purpose.
            },
        });
        const actor = createActor(testMachine);
        actor.start();

        actor.send({ type: "MESSAGE", text: "que horas sao?" });
        await waitForReady(actor);

        const snapshot = actor.getSnapshot();
        expect(snapshot.matches("listening")).toBe(true);
        // The error route's assign actually ran its console.error side effect.
        expect(errorSpy).toHaveBeenCalled();
        // chat() never returned, so no assistant reply was appended.
        expect(snapshot.context.messages).toEqual([
            { role: "user", content: "que horas sao?" },
        ]);

        errorSpy.mockRestore();
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
