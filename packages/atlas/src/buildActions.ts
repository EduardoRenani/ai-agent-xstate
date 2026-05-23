// Wrap `defineAgent.actions` callbacks so each lives in
// `setup({ actions: { name: assign(...) } })`. Spec:
// docs/specs/004-tasks.md Phase 5.5 + docs/specs/004-xstate-agent-wrapper.md
// §"Actions: named in passive, inline in routes" + §Mapping.
// Spec 005: the wrapper closes over the agent's frozen `deps` reference
// and threads it into every named action's argument envelope.
//
// The user wrote a plain callback returning `Partial<TContext>`. The wrapper
// is the only place that calls `xstate.assign(...)` for these — user code
// never imports from `xstate`. The callback's return type is forwarded to
// XState untouched (a runtime identity — the wrapper just adds the assign
// envelope so XState applies the patch to the context store).

import { assign } from "xstate";

type UserActionCallback = (args: {
    context: unknown;
    event: { type: string };
    deps: Readonly<Record<string, unknown>>;
}) => object;

export function buildActions(
    actions:
        | Readonly<Record<string, UserActionCallback>>
        | undefined,
    deps: Readonly<Record<string, unknown>>,
): Record<string, ReturnType<typeof assign>> {
    if (actions === undefined) return {};
    const out: Record<string, ReturnType<typeof assign>> = {};
    for (const [name, callback] of Object.entries(actions)) {
        out[name] = assign(({ context, event }) => callback({ context, event, deps }));
    }
    return out;
}
