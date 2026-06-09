// PROTOTYPE / design spike for spec 011 — unified self-suspending modes.
//
// Type-level only: `defineMode` is `declare`d (overloaded) so the SHAPE and the
// INFERENCE can be type-checked without implementing the XState lowering. NOT
// production code, does not touch the lib.
//
// Consolidated decisions from the debate, all visible below:
//   - one unified mode; `kind` is a single activation bit, NOT a separate type:
//       active  (default) = behavior-driven: enters dry-run (event: undefined)
//       passive            = event-driven: parks on entry, runs only on an event
//   - `behavior` is the core; returns a union of TWO natures:
//       { outcome: "achieved" | "abandoned" }    -> LEAVE the mode (carries a target)
//       { stay:    "replay"   | "waitOnEvent" }   -> STAY in the mode (re-run; no target)
//     replay = re-run immediately; waitOnEvent = re-run on the next event.
//   - what `event` a re-run carries differs by kind — and is the ONLY type
//     difference between active and passive:
//       active : entry & replay carry NO event   -> behavior sees Ev | undefined
//       passive: every run is event-driven (replay keeps the SAME event) -> Ev
//   - config mirrors the two-level tree: routes (exits, target+assign) /
//     stay (continuations, assign only). `assign` is the same shape everywhere.
//   - no tools/objective in the lib — they live in `deps`;
//   - `event` narrowed by hand via `event.type`; explicit type args kept.

// ── domain types (mirrors examples/zoe) ──────────────────────────────────
type Message = { role: "user" | "assistant"; content: string };
type AgentEvents = { type: "MESSAGE"; text: string };

type Deps = {
    teach: (messages: Message[]) => Promise<Message[]>;
    evaluate: (messages: Message[]) => Promise<"understood" | "not_understood" | "abandoned">;
};

// ── proposed Atlas surface (the unified mode contract) ────────────────────
declare const END: unique symbol;
type END = typeof END;

// XOR via `never`: the two natures cannot be mixed in one result.
type ModeResult<Pay> =
    | { outcome: "achieved" | "abandoned"; stay?: never; payload: Pay } // LEAVE
    | { stay: "replay" | "waitOnEvent"; outcome?: never; payload: Pay }; // STAY (same result for active & passive)

type Assign<Ctx, Pay, D> = (a: { context: Ctx; payload: Pay; deps: D }) => Partial<Ctx>;

// shared between both kinds — everything except the behavior's `event` type
type CommonConfig<Ctx, Ev extends { type: string }, Pay, D> = {
    input: (a: { context: Ctx; deps: D }) => unknown;
    events?: readonly Ev["type"][];
    routes: {
        achieved: { target: string | END; assign?: Assign<Ctx, Pay, D> };
        abandoned: { target: string | END; assign?: Assign<Ctx, Pay, D> };
    };
    stay?: {
        replay?: { assign?: Assign<Ctx, Pay, D> }; // re-run now (active: no event; passive: same event)
        waitOnEvent?: { assign?: Assign<Ctx, Pay, D> }; // re-run on the next event
    };
};

type ActiveModeConfig<Ctx, Ev extends { type: string }, Pay, D> = CommonConfig<Ctx, Ev, Pay, D> & {
    kind?: "active";
    behavior: (a: { input: unknown; event: Ev | undefined; deps: D }) => Promise<ModeResult<Pay>>;
};
type PassiveModeConfig<Ctx, Ev extends { type: string }, Pay, D> = CommonConfig<Ctx, Ev, Pay, D> & {
    kind: "passive";
    behavior: (a: { input: unknown; event: Ev; deps: D }) => Promise<ModeResult<Pay>>;
};

declare const modeBrand: unique symbol;
interface Mode<Ctx, Ev extends { type: string }, Pay, D> {
    readonly [modeBrand]: true;
    readonly __phantom?: (x: [Ctx, Ev, Pay, D]) => void;
}

// passive overload first (its `kind: "passive"` is the more specific match)
declare function defineMode<Ctx, Ev extends { type: string }, Pay, D>(
    config: PassiveModeConfig<Ctx, Ev, Pay, D>,
): Mode<Ctx, Ev, Pay, D>;
declare function defineMode<Ctx, Ev extends { type: string }, Pay, D>(
    config: ActiveModeConfig<Ctx, Ev, Pay, D>,
): Mode<Ctx, Ev, Pay, D>;

// ══════════════════════════════════════════════════════════════════════════
// MODE 1 — ACTIVE (default): the `socratic` compound collapsed into one mode.
// Enters by teaching (dry-run), replays to re-teach, waits for the reply.
// ══════════════════════════════════════════════════════════════════════════
type SocraticContext = { messages: Message[]; evalRetries: number };
type SocraticPayload = { messages: Message[] };

export const socratic = defineMode<SocraticContext, AgentEvents, SocraticPayload, Deps>({
    input: ({ context }) => ({ messages: context.messages, evalRetries: context.evalRetries }),
    events: ["MESSAGE"],

    behavior: async ({ input, event, deps }) => {
        const { messages, evalRetries } = input as { messages: Message[]; evalRetries: number };

        // an event is present -> the user replied; evaluate it. (active: event is Ev|undefined)
        if (event?.type === "MESSAGE") {
            const withReply: Message[] = [...messages, { role: "user", content: event.text }];
            const judgment = await deps.evaluate(withReply);
            if (judgment === "understood") return { outcome: "achieved", payload: { messages: withReply } };
            if (judgment === "abandoned" || evalRetries >= 3) return { outcome: "abandoned", payload: { messages: withReply } };
            return { stay: "replay", payload: { messages: withReply } }; // not understood -> replay (active replay carries NO event)
        }

        // no event: entry dry-run, OR the active `stay:"replay"` coming back (no event)
        // -> (re-)teach, then wait for the user's reply
        const taught = await deps.teach(messages);
        return { stay: "waitOnEvent", payload: { messages: taught } };
    },

    routes: {
        achieved: { target: END, assign: ({ payload }) => ({ messages: payload.messages }) },
        abandoned: { target: END, assign: ({ payload }) => ({ messages: payload.messages }) },
    },
    stay: {
        replay: {
            assign: ({ context, payload }) => ({
                messages: payload.messages,
                evalRetries: context.evalRetries + 1, // circuit breaker, via the standard assign
            }),
        },
        waitOnEvent: {
            assign: ({ payload }) => ({ messages: payload.messages }),
        },
    },
});

// ══════════════════════════════════════════════════════════════════════════
// MODE 2 — PASSIVE: the root `idle`/`listening`. Parks on entry; the behavior
// runs only on a MESSAGE. `event` is `AgentEvents` (never undefined) — no guard.
// ══════════════════════════════════════════════════════════════════════════
type IdleContext = { messages: Message[] };
type IdlePayload = { messages: Message[] };

export const idle = defineMode<IdleContext, AgentEvents, IdlePayload, Deps>({
    kind: "passive",
    events: ["MESSAGE"],
    input: ({ context }) => ({ messages: context.messages }),

    behavior: async ({ input, event }) => {
        // event: AgentEvents — never undefined in a passive mode, so no guard
        const { messages } = input as { messages: Message[] };
        const updated: Message[] = [...messages, { role: "user", content: event.text }];
        return { outcome: "achieved", payload: { messages: updated } };
    },

    routes: {
        achieved: { target: "classifying", assign: ({ payload }) => ({ messages: payload.messages }) },
        abandoned: { target: END },
    },
});
