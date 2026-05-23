// Spec 005 type tests: `TDeps` variance at slot time + `deps` threading in
// callback envelopes. Spec §`defineLeafMode` (split-brand contravariance) +
// §Routes / EventHandlers + §Verification.

import { describe, expectTypeOf, test } from "vitest";

import type {
    ActiveLeafModeConfig,
    EventTransition,
    ExitEntry,
    LeafMode,
    Mode,
    PassiveLeafModeConfig,
} from "../../src/types.ts";

type Ctx = { messages: readonly string[]; count: number };
type Events = { type: "MESSAGE"; text: string };
type P = { intent: "greet" | "learn" };

interface PgDriver { query(q: string): Promise<unknown>; }
interface SqliteDriver { exec(q: string): Promise<unknown>; }
interface Logger { info(m: string): void; }

describe("TDeps default (`Record<string, never>`) — slot anywhere", () => {
    test("a LeafMode with default TDeps is assignable to a slot demanding any TDeps", () => {
        // The slot inside a `ModesMap<C, E, AgentDeps>` is
        // `LeafMode<C, E, unknown, AgentDeps>`. Contravariance means a leaf
        // with `Record<string, never>` deps fits regardless of what the agent
        // declares.
        type DefaultLeaf = LeafMode<Ctx, Events, P>;
        type AgentSlotWithDb = LeafMode<Ctx, Events, unknown, { db: PgDriver }>;
        type AgentSlotWithAll = LeafMode<Ctx, Events, unknown, { db: PgDriver; logger: Logger }>;

        expectTypeOf<DefaultLeaf>().toMatchTypeOf<AgentSlotWithDb>();
        expectTypeOf<DefaultLeaf>().toMatchTypeOf<AgentSlotWithAll>();
    });
});

describe("TDeps variance — `LeafMode<…, ModeDeps>` fits slot when `AgentDeps` ⊇ `ModeDeps`", () => {
    test("mode demanding `{ db }` fits an agent with `{ db, logger }` (superset)", () => {
        type ModeNeedsDb = LeafMode<Ctx, Events, P, { db: PgDriver }>;
        type AgentSlot = LeafMode<Ctx, Events, unknown, { db: PgDriver; logger: Logger }>;
        expectTypeOf<ModeNeedsDb>().toMatchTypeOf<AgentSlot>();
    });

    test("mode demanding `{ db }` REJECTS an agent with just `{ logger }` (missing key)", () => {
        type ModeNeedsDb = LeafMode<Ctx, Events, P, { db: PgDriver }>;
        type AgentSlot = LeafMode<Ctx, Events, unknown, { logger: Logger }>;
        // @ts-expect-error - agent lacks `db`, mode needs it
        expectTypeOf<ModeNeedsDb>().toMatchTypeOf<AgentSlot>();
    });

    test("same key, incompatible value type — REJECTED at the slot", () => {
        // Mode wants `db: PgDriver` (a `query` method); agent provides
        // `db: SqliteDriver` (an `exec` method). The value types don't
        // unify, so contravariance rejects the slot.
        type ModeNeedsPg = LeafMode<Ctx, Events, P, { db: PgDriver }>;
        type AgentSlotSqlite = LeafMode<Ctx, Events, unknown, { db: SqliteDriver }>;
        // @ts-expect-error - PgDriver and SqliteDriver are not assignable
        expectTypeOf<ModeNeedsPg>().toMatchTypeOf<AgentSlotSqlite>();
    });

    test("same direction holds for `Mode` (compound)", () => {
        type CompoundNeedsDb = Mode<Ctx, Events, { db: PgDriver }>;
        type AgentSlotAll = Mode<Ctx, Events, { db: PgDriver; logger: Logger }>;
        type AgentSlotLoggerOnly = Mode<Ctx, Events, { logger: Logger }>;

        expectTypeOf<CompoundNeedsDb>().toMatchTypeOf<AgentSlotAll>();
        // @ts-expect-error - compound needs `db`, agent doesn't have it
        expectTypeOf<CompoundNeedsDb>().toMatchTypeOf<AgentSlotLoggerOnly>();
    });
});

describe("`deps` threading in callback envelopes", () => {
    type Deps = { db: PgDriver; logger: Logger };

    test("`input` sees `{ context, deps }`", () => {
        const config: ActiveLeafModeConfig<Ctx, Events, P, Deps> = {
            input: ({ context, deps }) => {
                expectTypeOf(context).toEqualTypeOf<Ctx>();
                expectTypeOf(deps).toEqualTypeOf<Deps>();
                return { messages: context.messages };
            },
            behavior: async ({ input, deps }) => {
                expectTypeOf(deps).toEqualTypeOf<Deps>();
                void input;
                return { outcome: "achieved", payload: { intent: "greet" } };
            },
            routes: {
                achieved: { target: "next" },
                retry: {},
                abandoned: { target: "fallback" },
            },
        };
        expectTypeOf(config).toMatchTypeOf<ActiveLeafModeConfig<Ctx, Events, P, Deps>>();
    });

    test("`routes.achieved.assign` sees `{ context, payload, deps }`", () => {
        const entry: ExitEntry<Ctx, P, Deps> = {
            target: "next",
            assign: ({ context, payload, deps }) => {
                expectTypeOf(context).toEqualTypeOf<Ctx>();
                expectTypeOf(payload).toEqualTypeOf<P>();
                expectTypeOf(deps).toEqualTypeOf<Deps>();
                return { count: context.count + 1 };
            },
        };
        expectTypeOf(entry).toMatchTypeOf<ExitEntry<Ctx, P, Deps>>();
    });

    test("`EventTransition.guard` sees `{ context, event, deps }`", () => {
        const config: PassiveLeafModeConfig<Ctx, Events, Deps> = {
            on: {
                MESSAGE: {
                    target: "next",
                    guard: ({ context, event, deps }) => {
                        expectTypeOf(context).toEqualTypeOf<Ctx>();
                        expectTypeOf(event).toEqualTypeOf<{ type: "MESSAGE"; text: string }>();
                        expectTypeOf(deps).toEqualTypeOf<Deps>();
                        return event.text.length > 0;
                    },
                },
            },
        };
        expectTypeOf(config).toMatchTypeOf<PassiveLeafModeConfig<Ctx, Events, Deps>>();
    });

    test("`EventTransition.guard` parameter type compiles equivalently across signature shapes", () => {
        // Sanity check: a guard can ignore `deps` (it's just an unused
        // destructured property), but referencing a key absent from `TDeps`
        // would be a compile error. The first form is the documented shape.
        const _full: NonNullable<EventTransition<Ctx, Events, Deps>["guard"]> =
            ({ context, event, deps }) => Boolean(context) && Boolean(event) && Boolean(deps);
        const _omitted: NonNullable<EventTransition<Ctx, Events, Deps>["guard"]> =
            ({ context, event }) => Boolean(context) && Boolean(event);
        expectTypeOf(_full).toBeFunction();
        expectTypeOf(_omitted).toBeFunction();
    });
});

describe("`when` stays deps-free (bare-value signature)", () => {
    test("`routes.achieved.when` is `(payload) => boolean` — no envelope", () => {
        type W = NonNullable<ExitEntry<Ctx, P>["when"]>;
        expectTypeOf<W>().toEqualTypeOf<(payload: P) => boolean>();
    });

    test("a user defining `when: ({ payload }) => …` is a compile error", () => {
        // The bare signature `(payload) => boolean` rejects a destructured
        // envelope argument — payload is the value itself, not a wrapper.
        // @ts-expect-error - `when` does not accept an `{ payload }` envelope
        const _bad: NonNullable<ExitEntry<Ctx, P>["when"]> = ({ payload }) => Boolean(payload);
        void _bad;
    });
});
