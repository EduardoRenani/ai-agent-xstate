// Wrap `defineAgent.actions` callbacks so each lives in
// `setup({ actions: { name: assign(...) } })`. Spec:
// docs/specs/004-tasks.md Phase 5.5 + docs/specs/004-xstate-agent-wrapper.md
// §"Actions: named in passive, inline in routes" + §Mapping.
// Spec 005: the wrapper closes over the agent's frozen `deps` reference
// and threads it into every named action's argument envelope.
//
// The user wrote a plain callback returning `Partial<TContext>`. The backend's
// `wrapAssign` is the only place that touches the engine's context-update
// primitive — user code never imports from `xstate`. The callback's return
// type is forwarded untouched (a runtime identity — the wrapper just adds the
// assign envelope so the engine applies the patch to the context store).

import { wrapAssign, type AssignAction } from "./xstateBackend.ts";

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
): Record<string, AssignAction> {
    if (actions === undefined) return {};
    const out: Record<string, AssignAction> = {};
    for (const [name, callback] of Object.entries(actions)) {
        out[name] = wrapAssign(({ context, event }) => callback({ context, event, deps }));
    }
    return out;
}
