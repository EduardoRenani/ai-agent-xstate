// Phase 5.3 runtime test: the `actors` map keys match the active leaves
// discovered by walk(); passive leaves are excluded. Spec:
// docs/specs/004-tasks.md Phase 5.3.

import { createActor } from "xstate";
import { describe, expect, test } from "vitest";

import { buildActors } from "../src/buildActors.ts";
import { defineLeafMode } from "../src/defineLeafMode.ts";
import { defineMode } from "../src/defineMode.ts";
import type { Mode, ModeOutput } from "../src/types.ts";
import { walk } from "../src/walk.ts";

type Ctx = { messages: readonly string[] };
type Events = { type: "MESSAGE"; text: string };

const rootListening = defineLeafMode<Ctx, Events>({
    on: { MESSAGE: { target: "classifying" } },
});

const classifying = defineLeafMode<Ctx, Events, { intent: "greeting" }>({
    input: ({ context }) => context.messages,
    behavior: async () => ({
        outcome: "achieved",
        payload: { intent: "greeting" },
    } satisfies ModeOutput<{ intent: "greeting" }>),
    routes: {
        achieved: { target: "greetings" },
        retry: {},
        abandoned: { target: "listening" },
    },
});

const greetingsThinking = defineLeafMode<Ctx, Events, undefined>({
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
    modes: { thinking: greetingsThinking },
    onDone: "listening",
});

const socraticTeaching = defineLeafMode<Ctx, Events, undefined>({
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

const socraticEvaluating = defineLeafMode<Ctx, Events, undefined>({
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

describe("buildActors()", () => {
    test("key set covers every active leaf, in walk() order, with passive leaves excluded", () => {
        const slots = walk(agentModes);
        const actors = buildActors(slots);

        expect(Object.keys(actors)).toEqual([
            // listening (root, passive) — excluded
            "classifyingNode",
            "greetingsThinkingNode",
            "socraticTeachingNode",
            // socratic.listening (passive) — excluded
            "socraticEvaluatingNode",
        ]);
    });

    test("each entry is a runnable actor logic that yields the user's ModeOutput", async () => {
        const slots = walk(agentModes);
        const actors = buildActors(slots);
        const logic = actors["classifyingNode"];
        expect(logic).toBeDefined();
        if (!logic) return;

        const actor = createActor(logic, { input: undefined });
        actor.start();
        const output = await new Promise<unknown>((resolve) => {
            actor.subscribe({
                complete: () => resolve(actor.getSnapshot().output),
            });
        });
        expect(output).toEqual({ outcome: "achieved", payload: { intent: "greeting" } });
    });

    test("returns {} when there are no active leaves", () => {
        const onlyPassive = walk({ listening: rootListening });
        expect(buildActors(onlyPassive)).toEqual({});
    });
});
