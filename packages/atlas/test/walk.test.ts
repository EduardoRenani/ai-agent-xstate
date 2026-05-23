// Phase 5.1 runtime test: tree walk enumerates every slot with the correct
// root-relative dotted path. Spec: docs/specs/004-tasks.md Phase 5.1.

import { describe, expect, test } from "vitest";

import { defineMode } from "../src/defineMode.ts";
import { defineCompoundMode } from "../src/defineCompoundMode.ts";
import type { CompoundMode, ModeOutput } from "../src/types.ts";
import { walk } from "../src/walk.ts";

type Ctx = { messages: readonly string[] };
type Events = { type: "MESSAGE"; text: string };

// Sample machine mirrors Zoe's shape so the test stays grounded in the real
// migration target: a root with passive `listening`, active `classifying`,
// and two compounds (`greetings`, `socratic`), one of which has nested
// active+passive leaves.

const rootListening = defineMode<Ctx, Events>({
    on: { MESSAGE: { target: "classifying" } },
});

const classifying = defineMode<Ctx, Events, { intent: "greeting" | "general" }>({
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

const greetingsThinking = defineMode<Ctx, Events, ModeOutput<undefined>["payload"]>({
    input: ({ context }) => context.messages,
    behavior: async () => ({ outcome: "achieved", payload: undefined } satisfies ModeOutput<undefined>),
    routes: {
        achieved: { target: "listening" },
        retry: {},
        abandoned: { target: "listening" },
    },
});

const greetings: CompoundMode<Ctx, Events> = defineCompoundMode<Ctx, Events, undefined, { thinking: typeof greetingsThinking }>({
    initial: "thinking",
    modes: { thinking: greetingsThinking },
    onDone: "listening",
});

const socraticTeaching = defineMode<Ctx, Events, ModeOutput<undefined>["payload"]>({
    input: ({ context }) => context.messages,
    behavior: async () => ({ outcome: "achieved", payload: undefined } satisfies ModeOutput<undefined>),
    routes: {
        achieved: { target: "listening" },
        retry: {},
        abandoned: { target: "listening" },
    },
});

const socraticListening = defineMode<Ctx, Events>({
    on: { MESSAGE: { target: "evaluating" } },
});

const socraticEvaluating = defineMode<Ctx, Events, ModeOutput<undefined>["payload"]>({
    input: ({ context }) => context.messages,
    behavior: async () => ({ outcome: "achieved", payload: undefined } satisfies ModeOutput<undefined>),
    routes: {
        achieved: { target: "teaching" },
        retry: {},
        abandoned: { target: "teaching" },
    },
});

const socratic: CompoundMode<Ctx, Events> = defineCompoundMode<
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
    modes: {
        teaching: socraticTeaching,
        listening: socraticListening,
        evaluating: socraticEvaluating,
    },
    onDone: "listening",
});

const agentModes = {
    listening: rootListening,
    classifying,
    greetings,
    socratic,
};

describe("walk()", () => {
    test("enumerates every slot in depth-first pre-order with dotted paths", () => {
        const slots = walk(agentModes);
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

    test("rejects raw values that are not Mode / CompoundMode carriers", () => {
        const bogus = { listening: { type: "atomic" } };
        expect(() => walk(bogus)).toThrow(/is not a Mode or CompoundMode/);
    });

    test("returns [] for an empty modes map", () => {
        expect(walk({})).toEqual([]);
    });
});
