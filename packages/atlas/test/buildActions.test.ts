// Phase 5.5 runtime test: user actions are wrapped in `assign(...)` and
// applied as XState named actions. Spec: docs/specs/004-tasks.md Phase 5.5.
//
// The test runs a minimal XState machine whose actions are supplied via
// `buildActions()`, then drives an event and asserts the context update.
// This proves both (a) the wrapping is structurally correct and (b) the
// user's plain `Partial<TContext>` return survives untouched.

import { createActor, setup } from "xstate";
import { describe, expect, test } from "vitest";

import { buildActions } from "../src/buildActions.ts";

type Ctx = { messages: readonly string[]; count: number };
type Events =
    | { type: "MESSAGE"; text: string }
    | { type: "RESET" };

describe("buildActions()", () => {
    test("returns {} when `actions` is undefined", () => {
        expect(buildActions(undefined, {})).toEqual({});
    });

    test("returns {} when `actions` is an empty record", () => {
        expect(buildActions({}, {})).toEqual({});
    });

    test("named actions apply the user's Partial<TContext> update via XState assign", () => {
        const actions = buildActions({
            appendUserMessage: ({ context, event }) => {
                if (event.type !== "MESSAGE") return {};
                const ctx = context as Ctx;
                return { messages: [...ctx.messages, event.text] };
            },
            bumpCount: ({ context }) => {
                const ctx = context as Ctx;
                return { count: ctx.count + 1 };
            },
        }, {});

        const machine = setup({
            types: {} as { context: Ctx; events: Events },
            actions,
        }).createMachine({
            id: "test",
            initial: "idle",
            context: { messages: [], count: 0 },
            states: {
                idle: {
                    on: {
                        MESSAGE: { actions: ["appendUserMessage", "bumpCount"] },
                        RESET: { actions: ["bumpCount"] },
                    },
                },
            },
        });

        const actor = createActor(machine);
        actor.start();
        actor.send({ type: "MESSAGE", text: "oi" });
        actor.send({ type: "MESSAGE", text: "tudo bem?" });
        actor.send({ type: "RESET" });

        expect(actor.getSnapshot().context).toEqual({
            messages: ["oi", "tudo bem?"],
            count: 3,
        });
    });

    test("preserves the user's action names (key set identity)", () => {
        const wrapped = buildActions({
            a: () => ({}),
            b: () => ({}),
            c: () => ({}),
        }, {});
        expect(Object.keys(wrapped).sort()).toEqual(["a", "b", "c"]);
    });
});
