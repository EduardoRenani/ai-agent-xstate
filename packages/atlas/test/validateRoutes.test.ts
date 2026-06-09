// Phase 5.15 runtime tests: route shape validator (belt-and-suspenders for
// the RouteList<E> constraint). Spec: docs/specs/004-tasks.md Phase 5.15.

import { describe, expect, test } from "vitest";

import { validateRoutes } from "../src/validateRoutes.ts";
import { END } from "../src/types.ts";

function activeLeaf(routes: object): { readonly __kind: "leaf"; readonly config: object } {
    return {
        __kind: "leaf",
        config: {
            input: () => undefined,
            behavior: async () => ({ outcome: "achieved", payload: undefined }),
            routes,
        },
    };
}

// SPEC 011: there are no more passive (`{ on: {} }`) leaves — every mode has a
// `behavior` + `routes`, so `validateRoutes` validates every leaf. The old
// "passive leaves are skipped" fixture/test is removed (concept deleted).

function compound(
    initial: string,
    modes: Record<string, unknown>,
    routes: unknown = {
        achieved: { target: END },
        abandoned: { target: END },
    },
): { readonly __kind: "compound"; readonly config: object } {
    return {
        __kind: "compound",
        config: { initial, modes, routes },
    };
}

describe("validateRoutes() — accepts well-formed shapes", () => {
    test("scalar entry on every slot", () => {
        expect(() =>
            validateRoutes({
                foo: activeLeaf({
                    achieved: { target: END },
                    abandoned: { target: END },
                }),
            }),
        ).not.toThrow();
    });

    test("missing `error` is allowed (optional)", () => {
        expect(() =>
            validateRoutes({
                foo: activeLeaf({
                    achieved: { target: END },
                    abandoned: { target: END },
                    // no error
                }),
            }),
        ).not.toThrow();
    });

    test("single-entry array (default-only) without `when`", () => {
        expect(() =>
            validateRoutes({
                foo: activeLeaf({
                    achieved: [{ target: END }],
                    abandoned: { target: END },
                }),
            }),
        ).not.toThrow();
    });

    test("multi-entry array: non-last carry `when`, last is unguarded default", () => {
        expect(() =>
            validateRoutes({
                foo: activeLeaf({
                    achieved: [
                        { when: () => true, target: END },
                        { when: () => true, target: END },
                        { target: END },
                    ],
                    abandoned: { target: END },
                }),
            }),
        ).not.toThrow();
    });

    test("error slot accepts RouteList shape", () => {
        expect(() =>
            validateRoutes({
                foo: activeLeaf({
                    achieved: { target: END },
                    abandoned: { target: END },
                    error: [
                        { when: () => true, target: END },
                        { target: END },
                    ],
                }),
            }),
        ).not.toThrow();
    });

    test("recurses into compounds", () => {
        expect(() =>
            validateRoutes({
                outer: compound("inner", {
                    inner: activeLeaf({
                        achieved: { target: END },
                        abandoned: { target: END },
                    }),
                }),
            }),
        ).not.toThrow();
    });
});

describe("validateRoutes() — rejects missing required slots", () => {
    test("missing achieved → throws naming routes.achieved", () => {
        expect(() =>
            validateRoutes({
                foo: activeLeaf({
                    abandoned: { target: END },
                }),
            }),
        ).toThrow(/routes\.achieved at "foo"[\s\S]*missing/);
    });

    test("missing abandoned → throws", () => {
        expect(() =>
            validateRoutes({
                foo: activeLeaf({
                    achieved: { target: END },
                }),
            }),
        ).toThrow(/routes\.abandoned at "foo"[\s\S]*missing/);
    });

    // SPEC 011: `retry` is no longer a route slot (continuations live in
    // `stay`, which is not a RouteList and is not shape-checked here), so the
    // old "missing retry → throws" test is removed — its premise is gone.
});

describe("validateRoutes() — rejects empty array on non-retry slots", () => {
    test("achieved: [] → rejected", () => {
        expect(() =>
            validateRoutes({
                foo: activeLeaf({
                    achieved: [],
                    abandoned: { target: END },
                }),
            }),
        ).toThrow(/routes\.achieved at "foo"[\s\S]*empty array/);
    });

    test("abandoned: [] → rejected", () => {
        expect(() =>
            validateRoutes({
                foo: activeLeaf({
                    achieved: { target: END },
                    abandoned: [],
                }),
            }),
        ).toThrow(/routes\.abandoned at "foo"[\s\S]*empty array/);
    });

    test("error: [] → rejected", () => {
        expect(() =>
            validateRoutes({
                foo: activeLeaf({
                    achieved: { target: END },
                    abandoned: { target: END },
                    error: [],
                }),
            }),
        ).toThrow(/routes\.error at "foo"[\s\S]*empty array/);
    });
});

describe("validateRoutes() — rejects `when` placement errors", () => {
    test("two-entry array, first lacks `when` → rejected (would shadow last)", () => {
        expect(() =>
            validateRoutes({
                foo: activeLeaf({
                    achieved: [
                        { target: END },
                        { target: END },
                    ],
                    abandoned: { target: END },
                }),
            }),
        ).toThrow(/routes\.achieved\[0\] at "foo"[\s\S]*shadow/);
    });

    test("three-entry array, middle lacks `when` → rejected at index 1", () => {
        expect(() =>
            validateRoutes({
                foo: activeLeaf({
                    achieved: [
                        { when: () => true, target: END },
                        { target: END },
                        { target: END },
                    ],
                    abandoned: { target: END },
                }),
            }),
        ).toThrow(/routes\.achieved\[1\] at "foo"[\s\S]*shadow/);
    });

    test("last entry carrying `when` → rejected (no unguarded default)", () => {
        expect(() =>
            validateRoutes({
                foo: activeLeaf({
                    achieved: [
                        { when: () => true, target: END },
                        { when: () => true, target: END },
                    ],
                    abandoned: { target: END },
                }),
            }),
        ).toThrow(/routes\.achieved\[1\] at "foo"[\s\S]*unguarded default/);
    });

    test("error array — same rules apply (non-last without when)", () => {
        expect(() =>
            validateRoutes({
                foo: activeLeaf({
                    achieved: { target: END },
                    abandoned: { target: END },
                    error: [{ target: END }, { target: END }],
                }),
            }),
        ).toThrow(/routes\.error\[0\] at "foo"[\s\S]*shadow/);
    });

    // SPEC 011: `retry` is gone — no RouteList shape rules apply to it (the old
    // "retry array — same rules apply" test is removed with its slot).
});

describe("validateRoutes() — rejects malformed slot values", () => {
    test("scalar slot value is not an object → rejected", () => {
        expect(() =>
            validateRoutes({
                foo: activeLeaf({
                    achieved: "not an object",
                    abandoned: { target: END },
                }),
            }),
        ).toThrow(/routes\.achieved at "foo"[\s\S]*object or array/);
    });

    test("scalar slot value is null → rejected", () => {
        expect(() =>
            validateRoutes({
                foo: activeLeaf({
                    achieved: null,
                    abandoned: { target: END },
                }),
            }),
        ).toThrow(/routes\.achieved at "foo"[\s\S]*object or array/);
    });
});

describe("validateRoutes() — error message format", () => {
    test("includes leaf path", () => {
        try {
            validateRoutes({
                outer: compound("inner", {
                    inner: activeLeaf({
                        achieved: [],
                        abandoned: { target: END },
                    }),
                }),
            });
            throw new Error("expected to throw");
        } catch (e) {
            expect((e as Error).message).toContain('"outer.inner"');
        }
    });

    test("includes slot name (routes.<slot>)", () => {
        try {
            validateRoutes({
                foo: activeLeaf({
                    achieved: { target: END },
                    abandoned: [],
                }),
            });
            throw new Error("expected to throw");
        } catch (e) {
            expect((e as Error).message).toContain("routes.abandoned");
        }
    });

    test("includes the offending index", () => {
        try {
            validateRoutes({
                foo: activeLeaf({
                    achieved: [
                        { when: () => true, target: END },
                        { target: END },
                        { target: END },
                    ],
                    abandoned: { target: END },
                }),
            });
            throw new Error("expected to throw");
        } catch (e) {
            expect((e as Error).message).toContain("routes.achieved[1]");
        }
    });
});

describe("validateRoutes() — carrier checks", () => {
    test("rejects raw (non-carrier) state node", () => {
        expect(() =>
            validateRoutes({
                foo: { type: "final" } as unknown,
            }),
        ).toThrow(/not a Mode or CompoundMode/);
    });

    test("rejects unknown carrier kind", () => {
        expect(() =>
            validateRoutes({
                foo: { __kind: "weird", config: {} } as unknown,
            }),
        ).toThrow(/unknown kind/);
    });
});
