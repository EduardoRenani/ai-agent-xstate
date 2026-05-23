// Phase 5.14 runtime tests: target resolution validator.
// Spec: docs/specs/004-tasks.md Phase 5.14,
// docs/specs/004-xstate-agent-wrapper.md §Target resolution.

import { describe, expect, test } from "vitest";

import { validateTargets } from "../src/validateTargets.ts";
import { END, RE_THROW } from "../src/types.ts";

// Minimal carrier builders. Validation cares about the runtime shape only —
// `__kind` discriminator + the relevant config fields. Bypassing
// `defineMode` / `defineCompoundMode` here keeps the tests focused on the
// validator and avoids dragging in TypeScript brand machinery.

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

function passiveLeaf(on: object): { readonly __kind: "leaf"; readonly config: object } {
    return {
        __kind: "leaf",
        config: { on },
    };
}

function compound(
    initial: string,
    modes: Record<string, unknown>,
    onDone: unknown,
): { readonly __kind: "compound"; readonly config: object } {
    return {
        __kind: "compound",
        config: { initial, modes, onDone },
    };
}

describe("validateTargets() — accepts valid targets", () => {
    test("active leaf with achieved targeting sibling", () => {
        expect(() =>
            validateTargets({
                foo: activeLeaf({
                    achieved: { target: "bar" },
                    retry: [],
                    abandoned: { target: "bar" },
                }),
                bar: activeLeaf({
                    achieved: { target: "foo" },
                    retry: [],
                    abandoned: { target: "foo" },
                }),
            }),
        ).not.toThrow();
    });

    test("active leaf with achieved targeting END", () => {
        expect(() =>
            validateTargets({
                foo: activeLeaf({
                    achieved: { target: END },
                    retry: [],
                    abandoned: { target: END },
                }),
            }),
        ).not.toThrow();
    });

    test("active leaf with error targeting RE_THROW", () => {
        expect(() =>
            validateTargets({
                foo: activeLeaf({
                    achieved: { target: END },
                    retry: [],
                    abandoned: { target: END },
                    error: { target: RE_THROW },
                }),
            }),
        ).not.toThrow();
    });

    test("passive leaf with on targeting sibling", () => {
        expect(() =>
            validateTargets({
                listening: passiveLeaf({ CLICK: { target: "thinking" } }),
                thinking: passiveLeaf({ CLICK: { target: "listening" } }),
            }),
        ).not.toThrow();
    });

    test("passive transition without target (internal action)", () => {
        expect(() =>
            validateTargets({
                listening: passiveLeaf({
                    CLICK: { actions: "doSomething" },
                }),
            }),
        ).not.toThrow();
    });

    test("compound onDone targeting sibling at the same level", () => {
        expect(() =>
            validateTargets({
                outer: compound(
                    "inner",
                    {
                        inner: activeLeaf({
                            achieved: { target: END },
                            retry: [],
                            abandoned: { target: END },
                        }),
                    },
                    "neighbor", // exits to sibling at the outer level
                ),
                neighbor: passiveLeaf({}),
            }),
        ).not.toThrow();
    });

    test("compound onDone targeting END", () => {
        expect(() =>
            validateTargets({
                outer: compound(
                    "inner",
                    {
                        inner: activeLeaf({
                            achieved: { target: END },
                            retry: [],
                            abandoned: { target: END },
                        }),
                    },
                    END,
                ),
            }),
        ).not.toThrow();
    });

    test("nested compounds: inner siblings differ from outer", () => {
        expect(() =>
            validateTargets({
                outer: compound(
                    "innerA",
                    {
                        innerA: activeLeaf({
                            achieved: { target: "innerB" },
                            retry: [],
                            abandoned: { target: END },
                        }),
                        innerB: passiveLeaf({}),
                    },
                    "outerSibling",
                ),
                outerSibling: passiveLeaf({}),
            }),
        ).not.toThrow();
    });

    test("array-form routes — each entry validated", () => {
        expect(() =>
            validateTargets({
                foo: activeLeaf({
                    achieved: [
                        { when: () => true, target: "bar" },
                        { target: "baz" },
                    ],
                    retry: [],
                    abandoned: { target: END },
                }),
                bar: passiveLeaf({}),
                baz: passiveLeaf({}),
            }),
        ).not.toThrow();
    });
});

describe("validateTargets() — rejects bad shapes", () => {
    test("dotted target → 'dotted paths are not accepted'", () => {
        expect(() =>
            validateTargets({
                foo: activeLeaf({
                    achieved: { target: "socratic.teaching" },
                    retry: [],
                    abandoned: { target: END },
                }),
            }),
        ).toThrow(/dotted paths are not accepted/);
    });

    test("#-prefixed target → 'absolute paths' rejection", () => {
        expect(() =>
            validateTargets({
                foo: activeLeaf({
                    achieved: { target: "#agent.root" },
                    retry: [],
                    abandoned: { target: END },
                }),
            }),
        // `#agent.root` contains `.` so the dotted-path check triggers first.
        ).toThrow(/dotted paths are not accepted|absolute paths/);
    });

    test("absolute target without dots → '#-prefixed' rejection", () => {
        expect(() =>
            validateTargets({
                foo: activeLeaf({
                    achieved: { target: "#agent" },
                    retry: [],
                    abandoned: { target: END },
                }),
            }),
        ).toThrow(/absolute paths/);
    });

    test("non-string non-END/RE_THROW target → structured error", () => {
        expect(() =>
            validateTargets({
                foo: activeLeaf({
                    achieved: { target: 42 },
                    retry: [],
                    abandoned: { target: END },
                }),
            }),
        ).toThrow(/target must be a sibling name/);
    });
});

describe("validateTargets() — rejects unknown siblings", () => {
    test("active leaf achieved → unknown sibling", () => {
        expect(() =>
            validateTargets({
                foo: activeLeaf({
                    achieved: { target: "nonexistent" },
                    retry: [],
                    abandoned: { target: END },
                }),
            }),
        ).toThrow(/no such sibling/);
    });

    test("error message lists available siblings", () => {
        expect(() =>
            validateTargets({
                foo: activeLeaf({
                    achieved: { target: "nonexistent" },
                    retry: [],
                    abandoned: { target: END },
                }),
                bar: passiveLeaf({}),
                baz: passiveLeaf({}),
            }),
        ).toThrow(/Available siblings: \["foo","bar","baz"\]/);
    });

    test("passive on → unknown sibling", () => {
        expect(() =>
            validateTargets({
                listening: passiveLeaf({ CLICK: { target: "ghost" } }),
            }),
        ).toThrow(/no such sibling/);
    });

    test("compound onDone → unknown outer sibling", () => {
        expect(() =>
            validateTargets({
                outer: compound(
                    "inner",
                    {
                        inner: activeLeaf({
                            achieved: { target: END },
                            retry: [],
                            abandoned: { target: END },
                        }),
                    },
                    "ghost",
                ),
            }),
        ).toThrow(/no such sibling/);
    });

    test("nested compound: child cannot target an OUTER sibling directly", () => {
        // `innerA` targets `outerSibling` (a sibling of `outer`, not of innerA).
        // The wrapper requires `END` for upward movement — spec line 829.
        expect(() =>
            validateTargets({
                outer: compound(
                    "innerA",
                    {
                        innerA: activeLeaf({
                            achieved: { target: "outerSibling" },
                            retry: [],
                            abandoned: { target: END },
                        }),
                    },
                    END,
                ),
                outerSibling: passiveLeaf({}),
            }),
        ).toThrow(/no such sibling/);
    });
});

describe("validateTargets() — error message format", () => {
    test("includes leaf path, slot descriptor, and literal target", () => {
        try {
            validateTargets({
                outer: compound(
                    "inner",
                    {
                        inner: activeLeaf({
                            achieved: { target: "ghost" },
                            retry: [],
                            abandoned: { target: END },
                        }),
                    },
                    END,
                ),
            });
            throw new Error("expected validateTargets to throw");
        } catch (e) {
            const msg = (e as Error).message;
            expect(msg).toContain('"ghost"');
            expect(msg).toContain('"outer.inner"');
            expect(msg).toContain("routes.achieved[0]");
        }
    });

    test("array-form indexing is preserved in slot descriptor", () => {
        try {
            validateTargets({
                foo: activeLeaf({
                    achieved: [
                        { when: () => true, target: "bar" },
                        { target: "ghost" },
                    ],
                    retry: [],
                    abandoned: { target: END },
                }),
                bar: passiveLeaf({}),
            });
            throw new Error("expected validateTargets to throw");
        } catch (e) {
            const msg = (e as Error).message;
            expect(msg).toContain("routes.achieved[1]");
            expect(msg).toContain('"ghost"');
        }
    });

    test("passive on descriptor includes event type", () => {
        try {
            validateTargets({
                listening: passiveLeaf({
                    CLICK: { target: "ghost" },
                }),
            });
            throw new Error("expected validateTargets to throw");
        } catch (e) {
            const msg = (e as Error).message;
            expect(msg).toContain("on.CLICK[0]");
            expect(msg).toContain('"ghost"');
            expect(msg).toContain('"listening"');
        }
    });

    test("compound onDone descriptor uses `onDone` literal", () => {
        try {
            validateTargets({
                outer: compound(
                    "inner",
                    {
                        inner: passiveLeaf({}),
                    },
                    "ghost",
                ),
            });
            throw new Error("expected validateTargets to throw");
        } catch (e) {
            const msg = (e as Error).message;
            expect(msg).toContain('"outer"');
            expect(msg).toContain("onDone");
            expect(msg).toContain('"ghost"');
        }
    });
});

describe("validateTargets() — carrier checks", () => {
    test("rejects raw (non-carrier) state node", () => {
        expect(() =>
            validateTargets({
                foo: { type: "final" } as unknown,
            }),
        ).toThrow(/not a Mode or CompoundMode/);
    });

    test("rejects unknown carrier kind", () => {
        expect(() =>
            validateTargets({
                foo: { __kind: "weird", config: {} } as unknown,
            }),
        ).toThrow(/unknown kind/);
    });
});
