// Spec 005 type tests: `TContext` constrained to `JsonCompatible<TContext>`
// at the field position (AgentConfig.context, CompoundContext.local). Spec
// §New Types + §Verification.

import { describe, expectTypeOf, test } from "vitest";

import type {
    AgentConfig,
    CompoundContext,
    JsonCompatible,
    JsonObject,
    LeafMode,
    ModesMap,
} from "../../src/types.ts";

type Events = { type: "MESSAGE"; text: string };

// Closed-shape contexts — these are the canonical shapes the constraint must
// accept (both type-alias and named-interface form pass).
type AliasCtx = { messages: readonly string[]; lastReply?: string };

interface InterfaceCtx {
    messages: readonly string[];
    lastReply?: string;
}

// A data-only class. Structurally indistinguishable from `{ role; content }`,
// `JSON.stringify` round-trips it identically, and the spec documents that
// the wrapper does not try to reject it (§New Types).
class Msg {
    constructor(public role: "user" | "assistant", public content: string) {}
}
type DataClassCtx = { items: readonly Msg[] };

// Stand-in placeholder for a mode slot — value-position only matters for the
// shape of `AgentConfig`'s `modes` field, not its content.
type AnySlot = ModesMap<never, Events>;

describe("JsonCompatible<TContext> — closed shapes compile", () => {
    test("type-alias-shaped context literal compiles", () => {
        type C = AgentConfig<AliasCtx, Events, AnySlot>;
        const config = {
            id: "x",
            initial: "a",
            context: { messages: [], lastReply: undefined } satisfies AliasCtx,
            events: {} as Events,
            modes: {} as AnySlot,
        };
        expectTypeOf(config).toMatchTypeOf<C>();
    });

    test("named-interface context compiles (no index signature required)", () => {
        type C = AgentConfig<InterfaceCtx, Events, AnySlot>;
        const config = {
            id: "x",
            initial: "a",
            context: { messages: [] } satisfies InterfaceCtx,
            events: {} as Events,
            modes: {} as AnySlot,
        };
        expectTypeOf(config).toMatchTypeOf<C>();
    });

    test("data-only class is accepted — structurally equal to plain object", () => {
        type C = AgentConfig<DataClassCtx, Events, AnySlot>;
        const config = {
            id: "x",
            initial: "a",
            context: { items: [new Msg("user", "hi")] } satisfies DataClassCtx,
            events: {} as Events,
            modes: {} as AnySlot,
        };
        expectTypeOf(config).toMatchTypeOf<C>();
    });

    test("open `JsonObject` shape is accepted", () => {
        type Ctx = { meta: JsonObject };
        type C = AgentConfig<Ctx, Events, AnySlot>;
        const config = {
            id: "x",
            initial: "a",
            context: { meta: { traceId: "abc", attempts: 2 } } satisfies Ctx,
            events: {} as Events,
            modes: {} as AnySlot,
        };
        expectTypeOf(config).toMatchTypeOf<C>();
    });
});

describe("JsonCompatible<TContext> — non-JSON values rejected", () => {
    test("Date is rejected", () => {
        type BadCtx = { lastSeen: Date };
        // The constraint substitutes `never` at the `Date` position, so the
        // user's literal fails to assign.
        const ctx: JsonCompatible<BadCtx> = {
            // @ts-expect-error - Date is not JsonCompatible
            lastSeen: new Date(),
        };
        void ctx;
    });

    test("Map is rejected", () => {
        type BadCtx = { byId: Map<string, number> };
        const ctx: JsonCompatible<BadCtx> = {
            // @ts-expect-error - Map is not JsonCompatible
            byId: new Map(),
        };
        void ctx;
    });

    test("Set is rejected", () => {
        type BadCtx = { tags: Set<string> };
        const ctx: JsonCompatible<BadCtx> = {
            // @ts-expect-error - Set is not JsonCompatible
            tags: new Set(),
        };
        void ctx;
    });

    test("bigint is rejected", () => {
        type BadCtx = { id: bigint };
        const ctx: JsonCompatible<BadCtx> = {
            // @ts-expect-error - bigint is not JsonCompatible
            id: 1n,
        };
        void ctx;
    });

    test("symbol is rejected", () => {
        type BadCtx = { tag: symbol };
        const ctx: JsonCompatible<BadCtx> = {
            // @ts-expect-error - symbol is not JsonCompatible
            tag: Symbol("x"),
        };
        void ctx;
    });

    test("class with methods is rejected", () => {
        // Unlike data-only classes, a class declaring a method has the
        // method's call signature in its shape — the `(...args) => unknown`
        // branch of `JsonCompatible` substitutes `never`.
        class WithMethod {
            constructor(public value: number) {}
            increment(): number { return this.value + 1; }
        }
        type BadCtx = { obj: WithMethod };
        const ctx: JsonCompatible<BadCtx> = {
            // @ts-expect-error - class with method is not JsonCompatible
            obj: new WithMethod(1),
        };
        void ctx;
    });

    test("a function-valued field is rejected", () => {
        type BadCtx = { fn: () => number };
        const ctx: JsonCompatible<BadCtx> = {
            // @ts-expect-error - function-valued field is not JsonCompatible
            fn: () => 1,
        };
        void ctx;
    });
});

describe("JsonCompatible — `undefined` admitted at optional fields", () => {
    test("optional field (`field?: T`) compiles — `T | undefined` is JsonCompatible", () => {
        type OptionalCtx = { messages: readonly string[]; cursor?: string };
        const ctx: JsonCompatible<OptionalCtx> = { messages: [], cursor: undefined };
        expectTypeOf(ctx).toMatchTypeOf<OptionalCtx>();

        const ctxNoCursor: JsonCompatible<OptionalCtx> = { messages: [] };
        expectTypeOf(ctxNoCursor).toMatchTypeOf<OptionalCtx>();
    });

    test("an explicit `T | undefined` non-optional field compiles", () => {
        type Ctx = { x: number | undefined };
        const ctx: JsonCompatible<Ctx> = { x: undefined };
        expectTypeOf(ctx).toMatchTypeOf<Ctx>();
    });
});

describe("CompoundContext.local — `JsonCompatible<TLocal>` constraint", () => {
    test("local with primitive values compiles", () => {
        type Parent = { messages: readonly string[] };
        const ctx: CompoundContext<Parent, readonly ["messages"], { attempts: number }> = {
            inherit: ["messages"] as const,
            local: { attempts: 0 },
        };
        expectTypeOf(ctx.local).toMatchTypeOf<{ attempts: number }>();
    });

    test("local with optional field compiles (`undefined` admitted)", () => {
        type Parent = { messages: readonly string[] };
        const ctx: CompoundContext<Parent, readonly ["messages"], { cursor?: string }> = {
            inherit: ["messages"] as const,
            local: { cursor: undefined },
        };
        expectTypeOf(ctx.local).toMatchTypeOf<{ cursor?: string }>();
    });

    test("local with a Date is rejected", () => {
        type Parent = { messages: readonly string[] };
        type Bad = CompoundContext<Parent, readonly ["messages"], { lastSeen: Date }>;
        const ctx: Bad = {
            inherit: ["messages"] as const,
            // @ts-expect-error - Date is not JsonCompatible
            local: { lastSeen: new Date() },
        };
        void ctx;
    });
});

describe("TPayload is unconstrained", () => {
    test("a leaf with an `Error` payload compiles", () => {
        type Ctx = { messages: readonly string[] };
        // The payload type itself is not constrained — only what
        // `routes.*.assign` writes to context is. An `Error` in the payload
        // is fine; it never flows into context unless the user writes it
        // there.
        type ErrLeaf = LeafMode<Ctx, Events, { err: Error }>;
        expectTypeOf<ErrLeaf>().toBeObject();
    });
});
