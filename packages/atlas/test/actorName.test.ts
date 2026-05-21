// Phase 5.2 runtime test: actor names derive from path via camelCase + "Node".
// Spec: docs/design-decisions.md DD-008 + docs/specs/004-tasks.md Phase 5.2.

import { describe, expect, test } from "vitest";

import { actorName } from "../src/actorName.ts";

describe("actorName()", () => {
    test("root leaf: single segment stays as-is + Node suffix", () => {
        expect(actorName("listening")).toBe("listeningNode");
        expect(actorName("classifying")).toBe("classifyingNode");
    });

    test("nested leaf: dotted path becomes camelCase", () => {
        // Spec-quoted example from docs/specs/004-tasks.md Phase 5.2.
        expect(actorName("socratic.evaluating")).toBe("socraticEvaluatingNode");
        expect(actorName("greetings.thinking")).toBe("greetingsThinkingNode");
    });

    test("deep nesting: every separator is collapsed and the following char uppercased", () => {
        expect(actorName("a.b.c")).toBe("aBCNode");
        expect(actorName("outer.middle.inner")).toBe("outerMiddleInnerNode");
    });

    test("rejects an empty path", () => {
        expect(() => actorName("")).toThrow(/empty path/);
    });

    test("rejects a malformed path with empty segments", () => {
        expect(() => actorName("socratic..evaluating")).toThrow(/empty segment/);
        expect(() => actorName(".leading")).toThrow(/empty segment/);
        expect(() => actorName("trailing.")).toThrow(/empty segment/);
    });
});
