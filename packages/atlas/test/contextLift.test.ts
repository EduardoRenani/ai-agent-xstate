// Unit tests for the compound-local lift primitives.
//
// Spec: docs/specs/004-xstate-agent-wrapper.md §"Lexical scoping of context"
//       + docs/specs/012-xstate-containment.md §Seam 3.
//
// Scope (post spec 012 §Seam 3): contextLift now exposes only the engine-neutral
// lift primitives — `compoundLocalKey`, the `buildSubContext` read-view, and the
// `makeCompoundEntry` / `makeCompoundExit` slot actions. The write-split
// (`splitUserUpdate`) and the per-callback patch/guard adaptation moved into
// `xstateBackend`'s IR translator; their behavior is covered end-to-end by the
// integration suites that drive the live `compile → lowerToIr → translateAgent`
// path (jsonContext, snapshotV2, compoundRoutes — compound-local writes split to
// the right slot/root and reset on re-entry).

import { describe, expect, test } from "vitest";

import {
    buildSubContext,
    compoundLocalKey,
    makeCompoundEntry,
    makeCompoundExit,
    type LiftContext,
} from "../src/contextLift.ts";

describe("compoundLocalKey()", () => {
    test("single segment → `__<name>_local`", () => {
        expect(compoundLocalKey("socratic")).toBe("__socratic_local");
    });

    test("dotted path → underscores", () => {
        expect(compoundLocalKey("socratic.evaluating")).toBe("__socratic_evaluating_local");
    });

    test("deep dotted path", () => {
        expect(compoundLocalKey("a.b.c.d")).toBe("__a_b_c_d_local");
    });

    test("empty path throws", () => {
        expect(() => compoundLocalKey("")).toThrow(/empty path/);
    });
});

describe("buildSubContext() — lifted read-view", () => {
    const lift: LiftContext = {
        key: "__socratic_local",
        inherit: ["messages"],
        initialLocal: { attempts: 0 },
    };

    test("presents only inherit (live from root) + local (from slot) keys", () => {
        const sub = buildSubContext(
            {
                messages: ["hi"],
                hidden: "should not be visible",
                __socratic_local: { attempts: 2 },
            },
            lift,
        );
        expect(sub).toEqual({ messages: ["hi"], attempts: 2 });
    });

    test("local keys read undefined when the slot is not yet initialized", () => {
        const sub = buildSubContext({ messages: ["hi"] }, lift);
        expect(sub).toEqual({ messages: ["hi"], attempts: undefined });
    });
});

describe("buildSubContext() — nested lift (parent chain)", () => {
    // Outer A has local { outerCount } inheriting `messages` from root.
    // Inner B inherits ["messages", "outerCount"] from A, with own
    // local { innerCount }.
    const outerLift: LiftContext = {
        key: "__a_local",
        inherit: ["messages"],
        initialLocal: { outerCount: 0 },
    };
    const innerLift: LiftContext = {
        key: "__a_b_local",
        inherit: ["messages", "outerCount"],
        initialLocal: { innerCount: 0 },
        parent: outerLift,
    };

    test("inner sees messages (root), outerCount (outer slot), and its own innerCount", () => {
        const sub = buildSubContext(
            {
                messages: ["m"],
                __a_local: { outerCount: 7 },
                __a_b_local: { innerCount: 3 },
            },
            innerLift,
        );
        expect(sub).toEqual({ messages: ["m"], outerCount: 7, innerCount: 3 });
    });
});

describe("makeCompoundEntry() / makeCompoundExit()", () => {
    const lift: LiftContext = {
        key: "__socratic_local",
        inherit: ["messages"],
        initialLocal: { attempts: 0, lastSeen: "" },
    };

    test("entry initializes the slot from initialLocal", () => {
        const entry = makeCompoundEntry(lift);
        // assign(...) with an object map: each key is a function called with
        // the args; the result builds the patch.
        const out = (entry as unknown as { assignment: Record<string, (args: unknown) => unknown> })
            .assignment;
        expect(out.__socratic_local({})).toEqual({ attempts: 0, lastSeen: "" });
    });

    test("entry returns a fresh copy each call (no shared reference between entries)", () => {
        const entry = makeCompoundEntry(lift);
        const out = (entry as unknown as { assignment: Record<string, (args: unknown) => unknown> })
            .assignment;
        const a = out.__socratic_local({});
        const b = out.__socratic_local({});
        expect(a).toEqual(b);
        expect(a).not.toBe(b);
    });

    test("exit clears the slot to undefined", () => {
        const exit = makeCompoundExit(lift);
        const out = (exit as unknown as { assignment: Record<string, (args: unknown) => unknown> })
            .assignment;
        expect(out.__socratic_local({})).toBe(undefined);
    });
});
