// Phase 5.3 runtime test: the `actors` map keys match the leaves discovered by
// walk(). Spec: docs/specs/004-tasks.md Phase 5.3.
//
// SPEC 011: the active/passive split is gone — EVERY leaf has a `behavior`, so
// EVERY leaf produces an actor (was: active leaves only, passive excluded). The
// actor's input is the `$run.invoke` envelope `{ userInput, event }`, which this
// wrapper unpacks before calling the behavior.

import { createActor } from "xstate";
import { describe, expect, test } from "vitest";

import { buildActors } from "../src/buildActors.ts";
import { defineMode } from "../src/defineMode.ts";
import { defineCompoundMode } from "../src/defineCompoundMode.ts";
import type { CompoundMode, ModeResult } from "../src/types.ts";
import { walk } from "../src/walk.ts";

type Ctx = { messages: readonly string[] };
type Events = { type: "MESSAGE"; text: string };

// SPEC 011: the old root passive `{ on: { MESSAGE: { target } } }` is now an
// event-mode — it parks on entry and runs its behavior on MESSAGE. It has a
// behavior, so (unlike before) it DOES produce an actor.
const rootListening = defineMode<Ctx, Events, undefined>({
    start: "event",
    events: ["MESSAGE"],
    input: ({ context }) => context.messages,
    behavior: async () => ({ outcome: "achieved", payload: undefined }),
    routes: {
        achieved: { target: "classifying" },
        abandoned: { target: "classifying" },
    },
});

const classifying = defineMode<Ctx, Events, { intent: "greeting" }>({
    input: ({ context }) => context.messages,
    behavior: async () => ({
        outcome: "achieved",
        payload: { intent: "greeting" },
    } satisfies ModeResult<{ intent: "greeting" }>),
    routes: {
        achieved: { target: "greetings" },
        abandoned: { target: "listening" },
    },
});

const greetingsThinking = defineMode<Ctx, Events, undefined>({
    input: ({ context }) => context.messages,
    behavior: async () => ({ outcome: "achieved", payload: undefined } satisfies ModeResult<undefined>),
    routes: {
        achieved: { target: "listening" },
        abandoned: { target: "listening" },
    },
});

const greetings: CompoundMode<Ctx, Events> = defineCompoundMode<Ctx, Events, undefined, { thinking: typeof greetingsThinking }>({
    initial: "thinking",
    modes: { thinking: greetingsThinking },
    routes: {
        achieved: { target: "listening" },
        abandoned: { target: "listening" },
    },
});

const socraticTeaching = defineMode<Ctx, Events, undefined>({
    input: ({ context }) => context.messages,
    behavior: async () => ({ outcome: "achieved", payload: undefined } satisfies ModeResult<undefined>),
    routes: {
        achieved: { target: "listening" },
        abandoned: { target: "listening" },
    },
});

// SPEC 011: was a passive `{ on: { MESSAGE: { target: "evaluating" } } }`; now an
// event-mode that runs on MESSAGE and routes to `evaluating` on achieved.
const socraticListening = defineMode<Ctx, Events, undefined>({
    start: "event",
    events: ["MESSAGE"],
    input: ({ context }) => context.messages,
    behavior: async () => ({ outcome: "achieved", payload: undefined }),
    routes: {
        achieved: { target: "evaluating" },
        abandoned: { target: "evaluating" },
    },
});

const socraticEvaluating = defineMode<Ctx, Events, undefined>({
    input: ({ context }) => context.messages,
    behavior: async () => ({ outcome: "achieved", payload: undefined } satisfies ModeResult<undefined>),
    routes: {
        achieved: { target: "teaching" },
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
    routes: {
        achieved: { target: "listening" },
        abandoned: { target: "listening" },
    },
});

const agentModes = {
    listening: rootListening,
    classifying,
    greetings,
    socratic,
};

describe("buildActors()", () => {
    test("key set covers every leaf, in walk() order, keyed by actorName(path)", () => {
        const slots = walk(agentModes);
        const actors = buildActors(slots, {});

        // SPEC 011: every leaf produces an actor now — including the (formerly
        // passive) root `listening` and `socratic.listening`, which are
        // event-modes here.
        expect(Object.keys(actors)).toEqual([
            "listeningNode",
            "classifyingNode",
            "greetingsThinkingNode",
            "socraticTeachingNode",
            "socraticListeningNode",
            "socraticEvaluatingNode",
        ]);
    });

    test("each entry is a runnable actor logic that yields the user's ModeResult", async () => {
        const slots = walk(agentModes);
        const actors = buildActors(slots, {});
        const logic = actors["classifyingNode"];
        expect(logic).toBeDefined();
        if (!logic) return;

        // SPEC 011: the actor unpacks the `$run.invoke` envelope `{ userInput,
        // event }`. `classifying`'s behavior ignores both, so a dry-run envelope
        // is enough to drive it.
        const actor = createActor(logic, { input: { userInput: undefined, event: undefined } });
        actor.start();
        const output = await new Promise<unknown>((resolve) => {
            actor.subscribe({
                complete: () => resolve(actor.getSnapshot().output),
            });
        });
        expect(output).toEqual({ outcome: "achieved", payload: { intent: "greeting" } });
    });

    test("returns {} when there are no leaves (empty modes map)", () => {
        // SPEC 011: there is no longer a "passive leaf produces no actor" case —
        // the only way to get an empty actor map is an empty modes map.
        expect(buildActors(walk({}), {})).toEqual({});
    });
});
