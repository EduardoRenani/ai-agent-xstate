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

function passiveLeaf(): { readonly __kind: "leaf"; readonly config: object } {
    return {
        __kind: "leaf",
        config: { on: {} },
    };
}

function compound(
    initial: string,
    states: Record<string, unknown>,
    onDone: unknown = END,
): { readonly __kind: "compound"; readonly config: object } {
    return {
        __kind: "compound",
        config: { initial, states, onDone },
    };
}

describe("validateRoutes() — accepts well-formed shapes", () => {
    test("scalar entry on every slot", () => {
        expect(() =>
            validateRoutes({
                foo: activeLeaf({
                    achieved: { target: END },
                    retry: {},
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
                    retry: {},
                    abandoned: { target: END },
                    // no error
                }),
            }),
        ).not.toThrow();
    });

    test("retry: readonly [] is the explicit no-op default", () => {
        expect(() =>
            validateRoutes({
                foo: activeLeaf({
                    achieved: { target: END },
                    retry: [],
                    abandoned: { target: END },
                }),
            }),
        ).not.toThrow();
    });

    test("single-entry array (default-only) without `when`", () => {
        expect(() =>
            validateRoutes({
                foo: activeLeaf({
                    achieved: [{ target: END }],
                    retry: [],
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
                    retry: [],
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
                    retry: [],
                    abandoned: { target: END },
                    error: [
                        { when: () => true, target: END },
                        { target: END },
                    ],
                }),
            }),
        ).not.toThrow();
    });

    test("passive leaves are ignored (no `routes`)", () => {
        expect(() =>
            validateRoutes({
                foo: passiveLeaf(),
            }),
        ).not.toThrow();
    });

    test("recurses into compounds", () => {
        expect(() =>
            validateRoutes({
                outer: compound("inner", {
                    inner: activeLeaf({
                        achieved: { target: END },
                        retry: [],
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
                    retry: [],
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
                    retry: [],
                }),
            }),
        ).toThrow(/routes\.abandoned at "foo"[\s\S]*missing/);
    });

    test("missing retry → throws (required by type, even if `[]` would satisfy it)", () => {
        expect(() =>
            validateRoutes({
                foo: activeLeaf({
                    achieved: { target: END },
                    abandoned: { target: END },
                }),
            }),
        ).toThrow(/routes\.retry at "foo"[\s\S]*missing/);
    });
});

describe("validateRoutes() — rejects empty array on non-retry slots", () => {
    test("achieved: [] → rejected", () => {
        expect(() =>
            validateRoutes({
                foo: activeLeaf({
                    achieved: [],
                    retry: [],
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
                    retry: [],
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
                    retry: [],
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
                    retry: [],
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
                    retry: [],
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
                    retry: [],
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
                    retry: [],
                    abandoned: { target: END },
                    error: [{ target: END }, { target: END }],
                }),
            }),
        ).toThrow(/routes\.error\[0\] at "foo"[\s\S]*shadow/);
    });

    test("retry array — same rules apply (last with when)", () => {
        expect(() =>
            validateRoutes({
                foo: activeLeaf({
                    achieved: { target: END },
                    retry: [{ when: () => true }, { when: () => true }],
                    abandoned: { target: END },
                }),
            }),
        ).toThrow(/routes\.retry\[1\] at "foo"[\s\S]*unguarded default/);
    });
});

describe("validateRoutes() — rejects malformed slot values", () => {
    test("scalar slot value is not an object → rejected", () => {
        expect(() =>
            validateRoutes({
                foo: activeLeaf({
                    achieved: "not an object",
                    retry: [],
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
                    retry: [],
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
                        retry: [],
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
                    retry: [],
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
                    retry: [],
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
        ).toThrow(/not a LeafMode or Mode/);
    });

    test("rejects unknown carrier kind", () => {
        expect(() =>
            validateRoutes({
                foo: { __kind: "weird", config: {} } as unknown,
            }),
        ).toThrow(/unknown kind/);
    });
});
