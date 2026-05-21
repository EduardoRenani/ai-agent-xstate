// Phase 5.4 runtime test: passive `LeafModeConfig` lowers to an XState
// atomic state whose `on` map mirrors the input verbatim (action-name
// strings preserved; guard callbacks preserved by identity). Spec:
// docs/specs/004-tasks.md Phase 5.4.

import { describe, expect, test } from "vitest";

import { buildPassiveState } from "../src/buildPassiveState.ts";
import { END } from "../src/types.ts";
import type { PassiveLeafModeConfig } from "../src/types.ts";

type Ctx = { messages: readonly string[] };
type Events =
    | { type: "MESSAGE"; text: string }
    | { type: "RESET" };

describe("buildPassiveState()", () => {
    test("single transition: `on[EVENT]` is the LoweredTransition object", () => {
        const config: PassiveLeafModeConfig<Ctx, Events> = {
            on: {
                MESSAGE: { target: "classifying" },
            },
        };
        expect(buildPassiveState(config)).toEqual({
            on: { MESSAGE: { target: "classifying" } },
        });
    });

    test("action-name strings are preserved verbatim", () => {
        const config: PassiveLeafModeConfig<Ctx, Events> = {
            on: {
                MESSAGE: {
                    target: "classifying",
                    actions: "appendUserMessage",
                },
                RESET: {
                    actions: ["clearMessages", "logEvent"],
                },
            },
        };
        const lowered = buildPassiveState(config);
        expect(lowered.on.MESSAGE).toEqual({
            target: "classifying",
            actions: "appendUserMessage",
        });
        expect(lowered.on.RESET).toEqual({
            actions: ["clearMessages", "logEvent"],
        });
    });

    test("guard callback is preserved by reference identity", () => {
        const guard = ({ event }: { context: Ctx; event: Events }) =>
            event.type === "MESSAGE" && event.text.length > 0;

        const config: PassiveLeafModeConfig<Ctx, Events> = {
            on: {
                MESSAGE: { target: "classifying", guard },
            },
        };
        const lowered = buildPassiveState(config);
        const t = lowered.on.MESSAGE;
        expect(Array.isArray(t)).toBe(false);
        if (Array.isArray(t)) return;
        expect(t.guard).toBe(guard);
    });

    test("array form: multiple transitions for the same event are preserved in order", () => {
        const config: PassiveLeafModeConfig<Ctx, Events> = {
            on: {
                MESSAGE: [
                    {
                        guard: ({ event }) => event.type === "MESSAGE" && event.text === "skip",
                        target: "listening",
                    },
                    { target: "classifying", actions: "appendUserMessage" },
                ],
            },
        };
        const lowered = buildPassiveState(config);
        const arr = lowered.on.MESSAGE;
        expect(Array.isArray(arr)).toBe(true);
        if (!Array.isArray(arr)) return;
        expect(arr).toHaveLength(2);
        expect(arr[1]).toEqual({ target: "classifying", actions: "appendUserMessage" });
    });

    test("END target stays as the END symbol (rewrite to `$end` substate is slice 5.11)", () => {
        const config: PassiveLeafModeConfig<Ctx, Events> = {
            on: {
                RESET: { target: END },
            },
        };
        const lowered = buildPassiveState(config);
        const t = lowered.on.RESET;
        expect(Array.isArray(t)).toBe(false);
        if (Array.isArray(t)) return;
        expect(t.target).toBe(END);
    });

    test("empty `on` map lowers to `{ on: {} }`", () => {
        const config: PassiveLeafModeConfig<Ctx, Events> = { on: {} };
        expect(buildPassiveState(config)).toEqual({ on: {} });
    });
});
