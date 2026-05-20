// Phase 5.1 runtime test: tree walk enumerates every slot with the correct
// root-relative dotted path. Spec: docs/specs/004-tasks.md Phase 5.1.

import { describe, expect, test } from "vitest";

import { defineLeafMode } from "../src/defineLeafMode.ts";
import { defineMode } from "../src/defineMode.ts";
import type { Mode, ModeOutput } from "../src/types.ts";
import { walk } from "../src/walk.ts";

type Ctx = { messages: readonly string[] };
type Events = { type: "MESSAGE"; text: string };

// Sample machine mirrors Zoe's shape so the test stays grounded in the real
// migration target: a root with passive `listening`, active `classifying`,
// and two compounds (`greetings`, `socratic`), one of which has nested
// active+passive leaves.

const rootListening = defineLeafMode<Ctx, Events>({
    on: { MESSAGE: { target: "classifying" } },
});

const classifying = defineLeafMode<Ctx, Events, { intent: "greeting" | "general" }>({
    input: ({ context }) => context.messages,
    behavior: async () => ({
        outcome: "achieved",
        payload: { intent: "greeting" },
    } satisfies ModeOutput<{ intent: "greeting" | "general" }>),
    routes: {
        achieved: { target: "greetings" },
        retry: {},
        abandoned: { target: "listening" },
    },
});

const greetingsThinking = defineLeafMode<Ctx, Events, ModeOutput<undefined>["payload"]>({
    input: ({ context }) => context.messages,
    behavior: async () => ({ outcome: "achieved", payload: undefined } satisfies ModeOutput<undefined>),
    routes: {
        achieved: { target: "listening" },
        retry: {},
        abandoned: { target: "listening" },
    },
});

const greetings: Mode<Ctx, Events> = defineMode<Ctx, Events, undefined, { thinking: typeof greetingsThinking }>({
    initial: "thinking",
    states: { thinking: greetingsThinking },
    onDone: "listening",
});

const socraticTeaching = defineLeafMode<Ctx, Events, ModeOutput<undefined>["payload"]>({
    input: ({ context }) => context.messages,
    behavior: async () => ({ outcome: "achieved", payload: undefined } satisfies ModeOutput<undefined>),
    routes: {
        achieved: { target: "listening" },
        retry: {},
        abandoned: { target: "listening" },
    },
});

const socraticListening = defineLeafMode<Ctx, Events>({
    on: { MESSAGE: { target: "evaluating" } },
});

const socraticEvaluating = defineLeafMode<Ctx, Events, ModeOutput<undefined>["payload"]>({
    input: ({ context }) => context.messages,
    behavior: async () => ({ outcome: "achieved", payload: undefined } satisfies ModeOutput<undefined>),
    routes: {
        achieved: { target: "teaching" },
        retry: {},
        abandoned: { target: "teaching" },
    },
});

const socratic: Mode<Ctx, Events> = defineMode<
    Ctx,
    Events,
    undefined,
    {
        teaching: typeof socraticTeaching;
        listening: typeof socraticListening;
        evaluating: typeof socraticEvaluating;
    }
>({
    initial: "teaching",
    states: {
        teaching: socraticTeaching,
        listening: socraticListening,
        evaluating: socraticEvaluating,
    },
    onDone: "listening",
});

const agentStates = {
    listening: rootListening,
    classifying,
    greetings,
    socratic,
};

describe("walk()", () => {
    test("enumerates every slot in depth-first pre-order with dotted paths", () => {
        const slots = walk(agentStates);
        const summary = slots.map((s) => ({ path: s.path, kind: s.kind }));

        expect(summary).toEqual([
            { path: "listening", kind: "leaf" },
            { path: "classifying", kind: "leaf" },
            { path: "greetings", kind: "compound" },
            { path: "greetings.thinking", kind: "leaf" },
            { path: "socratic", kind: "compound" },
            { path: "socratic.teaching", kind: "leaf" },
            { path: "socratic.listening", kind: "leaf" },
            { path: "socratic.evaluating", kind: "leaf" },
        ]);
    });

    test("rejects raw values that are not LeafMode / Mode carriers", () => {
        const bogus = { listening: { type: "atomic" } };
        expect(() => walk(bogus)).toThrow(/is not a LeafMode or Mode/);
    });

    test("returns [] for an empty states map", () => {
        expect(walk({})).toEqual([]);
    });
});
