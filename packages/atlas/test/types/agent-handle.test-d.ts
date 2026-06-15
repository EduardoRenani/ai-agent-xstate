// Type tests for the `Agent<TContext, TEvents>` opaque handle.
//
// Spec: docs/specs/012-xstate-containment.md §Seam 1 + §Verification
//       (type-level assertions: inference round-trip, cross-context restore
//        rejection, brand not hand-constructible).
//
// These run under `vitest --typecheck`; `@ts-expect-error` lines fail the run
// if the following statement compiles, and `expectTypeOf` checks inference.

import { describe, expectTypeOf, test } from "vitest";

import { defineAgent } from "../../src/defineAgent.ts";
import { defineMode } from "../../src/defineMode.ts";
import { startAgent } from "../../src/startAgent.ts";
import type { Agent, AgentActor, AgentSnapshot, PersistedAgentSnapshot } from "../../src/types.ts";

// ── Shared fixtures ──────────────────────────────────────────────────

type Ctx = { question: string; answer: string };
type Ev = { type: "ASK"; question: string } | { type: "ANSWER"; text: string };

const listening = defineMode<Ctx, Ev>({
    on: { ASK: { target: "answering" } },
});
const answering = defineMode<Ctx, Ev>({
    on: { ANSWER: { target: "listening" } },
});

type Modes = { listening: typeof listening; answering: typeof answering };

const agent = defineAgent<Ctx, Ev, Modes>({
    id: "qa",
    initial: "listening",
    context: { question: "", answer: "" },
    events: {} as Ev,
    modes: { listening, answering },
});

// Second agent with a DIFFERENT context shape, for cross-context checks.
type OtherCtx = { count: number };
type OtherEv = { type: "TICK" };
const otherLeaf = defineMode<OtherCtx, OtherEv>({ on: { TICK: { target: "otherLeaf" } } });
const otherAgent = defineAgent<OtherCtx, OtherEv, { otherLeaf: typeof otherLeaf }>({
    id: "other",
    initial: "otherLeaf",
    context: { count: 0 },
    events: {} as OtherEv,
    modes: { otherLeaf },
});

// ── defineAgent returns the opaque brand, not the carrier ────────────

describe("defineAgent return type", () => {
    test("returns Agent<Ctx, Ev> carrying both generics", () => {
        expectTypeOf(agent).toEqualTypeOf<Agent<Ctx, Ev>>();
    });
});

// ── startAgent infers TContext/TEvents from the brand ────────────────

describe("startAgent inference round-trip", () => {
    test("no type args needed — actor is typed from the agent", () => {
        const actor = startAgent(agent);
        expectTypeOf(actor).toEqualTypeOf<AgentActor<Ctx, Ev>>();
    });

    test("send is constrained to the inferred event union", () => {
        const actor = startAgent(agent);
        // Declared event compiles.
        actor.send({ type: "ASK", question: "what is a mode?" });
        // @ts-expect-error - undeclared event type is rejected by the inferred Ev
        actor.send({ type: "NOPE" });
    });

    test("getSnapshot is anchored to the inferred context", () => {
        const actor = startAgent(agent);
        expectTypeOf(actor.getSnapshot()).toEqualTypeOf<AgentSnapshot<Ctx>>();
    });
});

// ── Explicit-generics call form is cross-checked against the brand ───

describe("startAgent explicit generics are cross-checked", () => {
    test("matching generics still compile", () => {
        startAgent<Ctx, Ev>(agent);
    });

    test("mismatched context generic is a compile error", () => {
        // @ts-expect-error - <OtherCtx, ...> does not match the agent's brand (Ctx)
        startAgent<OtherCtx, Ev>(agent);
    });

    test("mismatched event generic is a compile error", () => {
        // @ts-expect-error - <_, OtherEv> does not match the agent's brand (Ev)
        startAgent<Ctx, OtherEv>(agent);
    });
});

// ── Cross-context snapshot restore is rejected ───────────────────────

describe("cross-context snapshot restore", () => {
    test("same-agent snapshot restores", () => {
        const snap = startAgent(agent).getSnapshot();
        startAgent(agent, { snapshot: snap });
    });

    test("snapshot from a different-context agent is rejected", () => {
        const otherSnap = startAgent(otherAgent).getSnapshot();
        // @ts-expect-error - AgentSnapshot<OtherCtx> is not assignable to the agent's AgentSnapshot<Ctx>
        startAgent(agent, { snapshot: otherSnap });
    });
});

// ── The brand is not hand-constructible ──────────────────────────────

describe("Agent brand opacity", () => {
    test("a raw carrier object is not an Agent", () => {
        // @ts-expect-error - missing the phantom brand; only defineAgent can mint an Agent
        const fake: Agent<Ctx, Ev> = { carrier: {} };
        void fake;
    });
});

// ── PersistedAgentSnapshot opacity (spec 012 §Seam 2, C5) ────────────

describe("PersistedAgentSnapshot opacity", () => {
    test("a snapshot's persisted payload is a PersistedAgentSnapshot", () => {
        const persisted = startAgent(agent).getSnapshot().persisted;
        expectTypeOf(persisted).toEqualTypeOf<PersistedAgentSnapshot>();
    });

    test("hosts cannot hand-construct the payload", () => {
        // @ts-expect-error - opaque brand; only Atlas mints PersistedAgentSnapshot
        const fake: PersistedAgentSnapshot = { value: 1, context: 2 };
        void fake;
    });
});
