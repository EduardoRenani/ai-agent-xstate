// SPEC 012 §Seam 2 verification — Atlas-owned persisted payload (atlasVersion "2").
//
// Spec: docs/specs/012-xstate-containment.md §Seam 2 + §Verification.
//
// These tests drive a real Atlas agent through `startAgent`'s v2 save/restore.
// The JSON round-trip case is also the spec-009 coverage the audit flagged as
// missing: persist a mode parked INSIDE a compound, stringify/parse, restore,
// and assert the mode path + compound-local slot survive and `entry` did not
// re-run (a re-run would reset the local back to its initial value).

import { describe, expect, test } from "vitest";

import { defineAgent } from "../src/defineAgent.ts";
import { defineMode } from "../src/defineMode.ts";
import { defineCompoundMode } from "../src/defineCompoundMode.ts";
import { formatModePath } from "../src/formatModePath.ts";
import { startAgent } from "../src/startAgent.ts";
import type { AgentSnapshot } from "../src/types.ts";

type RootCtx = { transcript: readonly string[] };
type Ev = { type: "RESUME" };

// Drain microtasks so async behaviors and the resulting transitions land.
async function settle(): Promise<void> {
    for (let i = 0; i < 40; i += 1) await new Promise<void>((r) => queueMicrotask(r));
}

// Read the Atlas-owned v2 payload (opaque to consumers; the tests look inside
// on purpose to assert the saved shape).
function payloadOf(snap: AgentSnapshot<RootCtx>): { value: unknown; context: Record<string, unknown> } {
    return snap.persisted as unknown as { value: unknown; context: Record<string, unknown> };
}

// An agent that, on boot, enters a compound `session`, bumps its `local`
// `attempts` to 1 (in the `working` child), then parks in the `waiting` child's
// `$wait` — i.e. parked INSIDE the compound with the local slot populated.
function buildSessionAgent() {
    type ChildCtx = { transcript: readonly string[]; attempts: number };

    const working = defineMode<ChildCtx, Ev, undefined>({
        input: () => null,
        behavior: async () => ({ outcome: "achieved", payload: undefined }),
        routes: {
            achieved: { target: "waiting", assign: ({ context }) => ({ attempts: context.attempts + 1 }) },
            abandoned: { target: "waiting" },
        },
    });
    const waiting = defineMode<ChildCtx, Ev>({
        start: "event",
        events: ["RESUME"],
        input: () => null,
        behavior: async () => ({ outcome: "achieved", payload: undefined }),
        routes: { achieved: { target: "waiting" }, abandoned: { target: "waiting" } },
    });

    const session = defineCompoundMode<RootCtx, Ev,
        { inherit: readonly ["transcript"]; local: { attempts: number } },
        { working: typeof working; waiting: typeof waiting }
    >({
        context: { inherit: ["transcript"] as const, local: { attempts: 0 } },
        initial: "working",
        modes: { working, waiting },
        // Unreachable scaffolding: `waiting` parks forever, so the compound
        // never exits. Self-target keeps `validateTargets` satisfied.
        routes: { achieved: { target: "session" }, abandoned: { target: "session" } },
    });

    return defineAgent<RootCtx, Ev, { session: typeof session }>({
        id: "v2-session",
        initial: "session",
        context: { transcript: [] },
        events: {} as Ev,
        modes: { session },
    });
}

describe("spec 012 §Seam 2 — v2 persisted payload save/restore", () => {
    test("getSnapshot stamps atlasVersion '2' and an Atlas-owned { value, context } payload", async () => {
        const agent = buildSessionAgent();
        const a = startAgent(agent);
        await settle();
        const snap = a.getSnapshot();
        a.stop();

        expect(snap.atlasVersion).toBe("2");
        const payload = payloadOf(snap);
        // Carrier-neutral descriptor, not XState's full blob (no children/status).
        expect(Object.keys(payload).sort()).toEqual(["atlasVersion", "context", "value"]);
        expect(formatModePath(payload.value)).toBe("session.waiting");
    });

    test("JSON round-trip preserves mode path + compound local; entry does not re-run", async () => {
        const agent = buildSessionAgent();
        const a = startAgent(agent);
        await settle(); // session → working bumps attempts=1 → waiting parks in $wait
        const snap = a.getSnapshot();
        a.stop();

        const before = payloadOf(snap);
        expect(formatModePath(before.value)).toBe("session.waiting");
        expect((before.context.__session_local as { attempts: number }).attempts).toBe(1);

        // Persist through durable storage exactly as a host would.
        const round = JSON.parse(JSON.stringify(snap)) as AgentSnapshot<RootCtx>;
        expect(round.atlasVersion).toBe("2");

        const b = startAgent(agent, { snapshot: round });
        await settle();
        const after = payloadOf(b.getSnapshot());
        b.stop();

        // Mode path survives.
        expect(formatModePath(after.value)).toBe("session.waiting");
        // Compound local survives AND entry did not re-run: a re-run would reset
        // `__session_local` to { attempts: 0 } (DD-018); it stays at 1.
        expect((after.context.__session_local as { attempts: number }).attempts).toBe(1);
        // The whole context round-trips structurally (covers every synthetic
        // slot, including `$event`, generically).
        expect(after.context).toEqual(before.context);
    });

    test("a version-1 payload is rejected on restore (soft reset to initial)", async () => {
        const first = defineMode<RootCtx, Ev>({
            start: "event",
            events: ["RESUME"],
            input: () => null,
            behavior: async () => ({ outcome: "achieved", payload: undefined }),
            routes: { achieved: { target: "first" }, abandoned: { target: "first" } },
        });
        const second = defineMode<RootCtx, Ev>({
            start: "event",
            events: ["RESUME"],
            input: () => null,
            behavior: async () => ({ outcome: "achieved", payload: undefined }),
            routes: { achieved: { target: "second" }, abandoned: { target: "second" } },
        });
        const agent = defineAgent<RootCtx, Ev, { first: typeof first; second: typeof second }>({
            id: "v1-reject",
            initial: "first",
            context: { transcript: [] },
            events: {} as Ev,
            modes: { first, second },
        });

        // A snapshot stamped "1" claiming the agent is parked in `second`.
        const fakeV1 = {
            atlasVersion: "1",
            persisted: { atlasVersion: "1", value: { second: "$wait" }, context: { transcript: [] } },
        } as unknown as AgentSnapshot<RootCtx>;

        let landed: string | undefined;
        const a = startAgent(agent, {
            snapshot: fakeV1,
            inspect: (e) => { if (landed === undefined) landed = e.to; },
        });
        await settle();
        a.stop();

        // Clarification C2: the v1 payload is ignored; the agent soft-resets to
        // `initial` (`first`), not the `second` the stale payload claimed.
        expect(landed).toBe("first");
    });
});
