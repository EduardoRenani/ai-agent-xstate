import { describe, it, expect, vi, beforeEach } from "vitest";

// Prevent OpenAI client instantiation at module level (no API key in tests),
// and let each test script chat()'s responses. SPEC 011: every mode (including
// the passive `listening`) runs a real `behavior` now, so the tests drive the
// REAL behaviors and only stub the LLM transport (`chat`).
vi.mock("../src/llm-client.js", () => ({ chat: vi.fn() }));

import { startAgent } from "@eduardorenani/atlasjs";

import { agentMachine } from "../src/machine.js";
import { chat } from "../src/llm-client.js";
import type { Message } from "../src/llm-client.js";
import type { AgentContext, AgentEvents } from "../src/types.js";

// ── Helpers ──────────────────────────────────────────────────────────

// A scripted `chat()`: the test inspects the system prompt + transcript and
// returns the canned reply. Four prompts exist in Zoe:
//   - "conversation classifier" → classify intent (JSON).
//   - "assistente educacional avaliando" → socratic evaluate (JSON judgment).
//   - "assistente educacional" → socratic teach (text).
//   - "proposito geral" → greetings OR improvising (text / tool round-trip).
// NOTE: the classifier's first-message fast-path maps a lone user message to
// "greetings" WITHOUT calling chat(), so the very first turn always greets.
type ChatScript = (messages: Message[], systemPrompt: string) => Message[];

function scriptChat(script: ChatScript): void {
    vi.mocked(chat).mockImplementation(async (messages, systemPrompt) =>
        script(messages, systemPrompt),
    );
}

// SPEC 011 Clarification #6: a parked passive/`waitOnEvent` mode sits in its
// synthetic `$wait` substate, but that segment is MASKED from `inspect`'s path
// (so `e.to` is just the mode name). Readiness is surfaced explicitly via
// `e.awaiting` — present and non-empty ONLY while parked, listing the event
// types that resume the mode. "Ready for the next message" = the agent parked.
function isParked(awaiting: readonly string[] | undefined): boolean {
    return awaiting !== undefined && awaiting.length > 0;
}

type Harness = {
    actor: ReturnType<typeof startAgent<AgentContext, AgentEvents>>;
    context: () => AgentContext;
    path: () => string;
    sendAndWaitForPark: (text: string) => Promise<void>;
};

function startHarness(): Harness {
    let lastContext: AgentContext = { messages: [], evalRetries: 0 };
    let lastPath = "(init)";
    let onPark: (() => void) | null = null;

    const actor = startAgent<AgentContext, AgentEvents>(agentMachine, {
        inspect: (e) => {
            lastContext = e.context;
            lastPath = e.to;
            // SPEC 011 Clarification #6: detect "parked" from the inspection
            // event's `awaiting`, not from a `.$wait` path suffix.
            if (isParked(e.awaiting) && onPark !== null) {
                const r = onPark;
                onPark = null;
                r();
            }
        },
    });

    return {
        actor,
        context: () => lastContext,
        path: () => lastPath,
        sendAndWaitForPark: (text: string) =>
            new Promise<void>((resolve) => {
                onPark = resolve;
                actor.send({ type: "MESSAGE", text });
            }),
    };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("agentMachine", () => {
    beforeEach(() => {
        vi.mocked(chat).mockReset();
    });

    it("handles simple greeting then question", async () => {
        let classifyCall = 0;
        scriptChat((messages, systemPrompt) => {
            if (systemPrompt.includes("conversation classifier")) {
                // classify only runs from the 2nd turn on (1st turn fast-paths
                // to greetings). Sequence: none, improvise, none.
                classifyCall++;
                const seq = ["none", "improvise", "none"];
                return [{ role: "assistant", content: JSON.stringify({ intent: seq[classifyCall - 1] ?? "none" }) }];
            }
            if (systemPrompt.includes("proposito geral")) {
                const lastUser = [...messages].reverse().find((m) => m.role === "user");
                const content = lastUser && lastUser.content.includes("capital")
                    ? "Brasilia."
                    : "Ola! Sou Zoe.";
                return [{ role: "assistant", content }];
            }
            throw new Error(`unexpected systemPrompt: ${systemPrompt.slice(0, 40)}`);
        });

        const h = startHarness();

        // First message: greetings fast-path → greetings → classify(none) → listening.
        await h.sendAndWaitForPark("oi");
        expect(h.path()).toBe("listening");
        expect(h.context().messages).toEqual([
            { role: "user", content: "oi" },
            { role: "assistant", content: "Ola! Sou Zoe." },
        ]);

        // Second message: classify(improvise) → improvising → classify(none) → listening.
        await h.sendAndWaitForPark("qual a capital do Brasil?");
        expect(h.path()).toBe("listening");
        expect(h.context().messages).toEqual([
            { role: "user", content: "oi" },
            { role: "assistant", content: "Ola! Sou Zoe." },
            { role: "user", content: "qual a capital do Brasil?" },
            { role: "assistant", content: "Brasilia." },
        ]);

        h.actor.stop();
    });

    it("routes to socratic, teaches, parks, evaluates understood → listening", async () => {
        // Latch: route to socratic once (the "closures" request), then none —
        // the closing classify after socratic exits must NOT loop back in.
        let taught = false;
        scriptChat((messages, systemPrompt) => {
            if (systemPrompt.includes("conversation classifier")) {
                const transcript = messages.map((m) => m.content ?? "").join("\n");
                const intent = transcript.includes("closures") && !taught ? "socratic" : "none";
                return [{ role: "assistant", content: JSON.stringify({ intent }) }];
            }
            if (systemPrompt.includes("assistente educacional avaliando")) {
                return [{ role: "assistant", content: JSON.stringify({ judgment: "understood" }) }];
            }
            if (systemPrompt.includes("assistente educacional")) {
                taught = true;
                return [{ role: "assistant", content: "Closures capturam variaveis. O que acontece com x?" }];
            }
            if (systemPrompt.includes("proposito geral")) {
                return [{ role: "assistant", content: "Ola! Sou Zoe." }];
            }
            throw new Error(`unexpected systemPrompt: ${systemPrompt.slice(0, 40)}`);
        });

        const h = startHarness();

        // Greet first (fast-path), then the socratic request on the next turn.
        await h.sendAndWaitForPark("oi");
        await h.sendAndWaitForPark("me explica closures");
        // SPEC 011: socratic is now a single leaf; parked → masked "socratic".
        expect(h.path()).toBe("socratic");

        // User answers → evaluate(understood) → achieved → classify(none) → listening.
        await h.sendAndWaitForPark("x continua acessivel pela funcao interna");
        expect(h.path()).toBe("listening");
        expect(h.context().messages).toEqual([
            { role: "user", content: "oi" },
            { role: "assistant", content: "Ola! Sou Zoe." },
            { role: "user", content: "me explica closures" },
            { role: "assistant", content: "Closures capturam variaveis. O que acontece com x?" },
            { role: "user", content: "x continua acessivel pela funcao interna" },
        ]);
        // Circuit breaker reset on exit.
        expect(h.context().evalRetries).toBe(0);

        h.actor.stop();
    });

    it("re-teaches on not_understood (stay:replay) then passes", async () => {
        let taught = false;
        let evalCall = 0;
        let teachCall = 0;
        scriptChat((messages, systemPrompt) => {
            if (systemPrompt.includes("conversation classifier")) {
                const transcript = messages.map((m) => m.content ?? "").join("\n");
                const intent = transcript.includes("closures") && !taught ? "socratic" : "none";
                return [{ role: "assistant", content: JSON.stringify({ intent }) }];
            }
            if (systemPrompt.includes("assistente educacional avaliando")) {
                evalCall++;
                const judgment = evalCall === 1 ? "not_understood" : "understood";
                return [{ role: "assistant", content: JSON.stringify({ judgment }) }];
            }
            if (systemPrompt.includes("assistente educacional")) {
                taught = true;
                teachCall++;
                const content = teachCall === 1 ? "Explicacao inicial. Pergunta?" : "Explicacao revisada. Tente?";
                return [{ role: "assistant", content }];
            }
            if (systemPrompt.includes("proposito geral")) {
                return [{ role: "assistant", content: "Ola! Sou Zoe." }];
            }
            throw new Error(`unexpected systemPrompt: ${systemPrompt.slice(0, 40)}`);
        });

        const h = startHarness();

        await h.sendAndWaitForPark("oi");
        await h.sendAndWaitForPark("me explica closures");
        expect(h.path()).toBe("socratic");

        // Wrong answer → evaluate(not_understood) → stay:replay → re-teach → park.
        await h.sendAndWaitForPark("nao sei");
        expect(h.path()).toBe("socratic");
        // evalRetries bumped once by the replay assign.
        expect(h.context().evalRetries).toBe(1);

        // Correct answer → evaluate(understood) → achieved → listening.
        await h.sendAndWaitForPark("agora eu sei");
        expect(h.path()).toBe("listening");
        expect(h.context().messages).toEqual([
            { role: "user", content: "oi" },
            { role: "assistant", content: "Ola! Sou Zoe." },
            { role: "user", content: "me explica closures" },
            { role: "assistant", content: "Explicacao inicial. Pergunta?" },
            { role: "user", content: "nao sei" },
            { role: "assistant", content: "Explicacao revisada. Tente?" },
            { role: "user", content: "agora eu sei" },
        ]);
        expect(h.context().evalRetries).toBe(0);

        h.actor.stop();
    });

    it("circuit-breaks the socratic re-teach loop at evalRetries === RETRY_LIMIT", async () => {
        let taught = false;
        scriptChat((messages, systemPrompt) => {
            if (systemPrompt.includes("conversation classifier")) {
                const transcript = messages.map((m) => m.content ?? "").join("\n");
                const intent = transcript.includes("closures") && !taught ? "socratic" : "none";
                return [{ role: "assistant", content: JSON.stringify({ intent }) }];
            }
            if (systemPrompt.includes("assistente educacional avaliando")) {
                // Always unparseable → judgment "unknown" → stay:replay (re-teach),
                // bumping evalRetries each time until the breaker (>= 3) abandons.
                return [{ role: "assistant", content: "isto nao e json valido" }];
            }
            if (systemPrompt.includes("assistente educacional")) {
                taught = true;
                return [{ role: "assistant", content: "Explicacao. Pergunta?" }];
            }
            if (systemPrompt.includes("proposito geral")) {
                return [{ role: "assistant", content: "Ola! Sou Zoe." }];
            }
            throw new Error(`unexpected systemPrompt: ${systemPrompt.slice(0, 40)}`);
        });

        const h = startHarness();

        await h.sendAndWaitForPark("oi");
        await h.sendAndWaitForPark("me explica closures");
        expect(h.path()).toBe("socratic");

        // Each unparseable judgment → stay:replay → re-teach → re-park, bumping
        // evalRetries. The breaker fires BEFORE the re-teach: when a replay pushes
        // evalRetries to the cap (3), the no-event re-run abandons instead of
        // teaching a 4th time. So the 3rd unparseable reply already exits.
        await h.sendAndWaitForPark("hmm");           // replay→retries=1 → re-teach → park
        expect(h.path()).toBe("socratic");
        expect(h.context().evalRetries).toBe(1);
        await h.sendAndWaitForPark("sei la");        // retries=2 → re-teach → park
        expect(h.context().evalRetries).toBe(2);
        await h.sendAndWaitForPark("nada");          // retries=3 → breaker abandons → listening
        expect(h.path()).toBe("listening");
        // Reset on exit.
        expect(h.context().evalRetries).toBe(0);

        h.actor.stop();
    });

    it("handles socratic abandonment", async () => {
        let taught = false;
        scriptChat((messages, systemPrompt) => {
            if (systemPrompt.includes("conversation classifier")) {
                // socratic on the "closures" request; after abandon, the user's
                // "horas" question (unanswered) → improvise; else none.
                const transcript = messages.map((m) => m.content ?? "").join("\n");
                let intent = "none";
                if (transcript.includes("closures") && !taught) intent = "socratic";
                else if (transcript.includes("horas") && !transcript.includes("10:30")) intent = "improvise";
                return [{ role: "assistant", content: JSON.stringify({ intent }) }];
            }
            if (systemPrompt.includes("assistente educacional avaliando")) {
                return [{ role: "assistant", content: JSON.stringify({ judgment: "abandoned" }) }];
            }
            if (systemPrompt.includes("assistente educacional")) {
                taught = true;
                return [{ role: "assistant", content: "Explicacao. Pergunta?" }];
            }
            if (systemPrompt.includes("proposito geral")) {
                const lastUser = [...messages].reverse().find((m) => m.role === "user");
                const content = lastUser && lastUser.content.includes("horas") ? "Sao 10:30." : "Ola! Sou Zoe.";
                return [{ role: "assistant", content }];
            }
            throw new Error(`unexpected systemPrompt: ${systemPrompt.slice(0, 40)}`);
        });

        const h = startHarness();

        await h.sendAndWaitForPark("oi");
        await h.sendAndWaitForPark("me explica closures");
        expect(h.path()).toBe("socratic");

        // User abandons → evaluate(abandoned) → abandoned → classify(improvise)
        // → improvising → classify(none) → listening.
        await h.sendAndWaitForPark("para, me diz que horas sao");
        expect(h.path()).toBe("listening");
        expect(h.context().messages).toEqual([
            { role: "user", content: "oi" },
            { role: "assistant", content: "Ola! Sou Zoe." },
            { role: "user", content: "me explica closures" },
            { role: "assistant", content: "Explicacao. Pergunta?" },
            { role: "user", content: "para, me diz que horas sao" },
            { role: "assistant", content: "Sao 10:30." },
        ]);

        h.actor.stop();
    });

    it("handles improvising with tool messages", async () => {
        scriptChat((messages, systemPrompt) => {
            if (systemPrompt.includes("conversation classifier")) {
                // `classifying` formats the whole transcript into one synthetic
                // user message. Improvise only while the "horas" question is
                // unanswered (the assistant's "10:30" tail not yet present);
                // the closing classify sees that tail → none.
                const transcript = messages.map((m) => m.content ?? "").join("\n");
                const intent = transcript.includes("horas") && !transcript.includes("10:30")
                    ? "improvise"
                    : "none";
                return [{ role: "assistant", content: JSON.stringify({ intent }) }];
            }
            if (systemPrompt.includes("proposito geral")) {
                const lastUser = [...messages].reverse().find((m) => m.role === "user");
                if (lastUser?.content.includes("horas")) {
                    // improvising returns a full tool round-trip transcript.
                    return [
                        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_current_time", arguments: "{}" } }] },
                        { role: "tool", content: "2026-05-14T10:30:00Z", tool_call_id: "call_1" },
                        { role: "assistant", content: "Sao 10:30 da manha!" },
                    ];
                }
                return [{ role: "assistant", content: "Ola! Sou Zoe." }];
            }
            throw new Error(`unexpected systemPrompt: ${systemPrompt.slice(0, 40)}`);
        });

        const h = startHarness();
        await h.sendAndWaitForPark("oi");
        await h.sendAndWaitForPark("que horas sao?");

        expect(h.path()).toBe("listening");
        const msgs = h.context().messages;
        expect(msgs).toContainEqual({ role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_current_time", arguments: "{}" } }] });
        expect(msgs).toContainEqual({ role: "tool", content: "2026-05-14T10:30:00Z", tool_call_id: "call_1" });
        expect(msgs).toContainEqual({ role: "assistant", content: "Sao 10:30 da manha!" });

        h.actor.stop();
    });

    it("recovers to listening when improvising's chat() throws (error route logs, no crash)", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        // improvising routes its error to `classifying` keeping `messages`, so a
        // second classify of the same (now answer-less) "horas" question would
        // re-enter improvising forever. Latch: route the question to improvise
        // exactly once, then to none so the error recovery terminates.
        let improvised = false;
        scriptChat((messages, systemPrompt) => {
            if (systemPrompt.includes("conversation classifier")) {
                const transcript = messages.map((m) => m.content ?? "").join("\n");
                const intent = transcript.includes("horas") && !improvised ? "improvise" : "none";
                return [{ role: "assistant", content: JSON.stringify({ intent }) }];
            }
            if (systemPrompt.includes("proposito geral")) {
                const lastUser = [...messages].reverse().find((m) => m.role === "user");
                if (lastUser?.content.includes("horas")) {
                    improvised = true;
                    throw new Error("LLM transport boom");
                }
                return [{ role: "assistant", content: "Ola! Sou Zoe." }];
            }
            throw new Error(`unexpected systemPrompt: ${systemPrompt.slice(0, 40)}`);
        });

        const h = startHarness();
        // Greet first, then the real question: improvising → chat() throws →
        // error route logs and routes to classifying → listening.
        await h.sendAndWaitForPark("oi");
        await h.sendAndWaitForPark("que horas sao?");

        expect(h.path()).toBe("listening");
        expect(errorSpy).toHaveBeenCalled();

        errorSpy.mockRestore();
        h.actor.stop();
    });

    it("handles multiple turns — greeting then improvise then improvise", async () => {
        let classifyCall = 0;
        scriptChat((messages, systemPrompt) => {
            if (systemPrompt.includes("conversation classifier")) {
                classifyCall++;
                // none(after greet) / improvise / none / improvise / none
                const seq = ["none", "improvise", "none", "improvise", "none"];
                return [{ role: "assistant", content: JSON.stringify({ intent: seq[classifyCall - 1] ?? "none" }) }];
            }
            if (systemPrompt.includes("proposito geral")) {
                const lastUser = [...messages].reverse().find((m) => m.role === "user");
                const text = lastUser?.content ?? "";
                if (text.includes("capital")) return [{ role: "assistant", content: "Brasilia." }];
                if (text.includes("populacao")) return [{ role: "assistant", content: "Cerca de 200 milhoes." }];
                return [{ role: "assistant", content: "Ola! Sou Zoe." }];
            }
            throw new Error(`unexpected systemPrompt: ${systemPrompt.slice(0, 40)}`);
        });

        const h = startHarness();

        await h.sendAndWaitForPark("oi");
        await h.sendAndWaitForPark("capital do Brasil?");
        await h.sendAndWaitForPark("e a populacao?");

        expect(h.path()).toBe("listening");
        expect(h.context().messages).toEqual([
            { role: "user", content: "oi" },
            { role: "assistant", content: "Ola! Sou Zoe." },
            { role: "user", content: "capital do Brasil?" },
            { role: "assistant", content: "Brasilia." },
            { role: "user", content: "e a populacao?" },
            { role: "assistant", content: "Cerca de 200 milhoes." },
        ]);

        h.actor.stop();
    });
});
