// Build the `actors` map for XState's `setup({ actors })`. Spec:
// docs/specs/004-tasks.md Phase 5.3 + docs/specs/004-xstate-agent-wrapper.md
// §Mapping. Spec 005: the wrapper closes over the agent's frozen `deps`
// reference and threads it into every active leaf's `behavior` callback.
//
// One entry per active `LeafMode` slot, keyed by `actorName(path)`. Each
// entry wraps the user's `behavior` in
// `fromPromise(async ({ input }) => behavior({ input, deps }))` — the only
// place the wrapper bridges user code to XState's actor runtime.
// Passive leaves do not produce an actor; they are atomic states with `on`
// handlers (handled in slice 5.4).

import { fromPromise } from "xstate";
import type { AnyActorLogic } from "xstate";

import { actorName } from "./actorName.ts";
import type { Slot } from "./walk.ts";

export function buildActors(
    slots: readonly Slot[],
    deps: Readonly<Record<string, unknown>>,
): Record<string, AnyActorLogic> {
    const actors: Record<string, AnyActorLogic> = {};
    for (const slot of slots) {
        if (slot.kind !== "leaf") continue;
        const config = slot.config;
        if (!("behavior" in config)) continue; // passive leaf — no actor

        const name = actorName(slot.path);
        if (name in actors) {
            // Two leaves sharing an actor name would silently overwrite. Per
            // DD-008 the name is derived from path, so a collision here means
            // two slots share a path — which `walk()` already prevents — or
            // future renames broke the invariant. Fail loudly.
            throw new Error(
                `atlas/buildActors: duplicate actor name "${name}" at path "${slot.path}"`,
            );
        }
        // The user's `behavior` was typed against its own `TDeps` at the
        // `defineLeafMode` call site; the internal carrier here erases that
        // generic to the default `Record<string, never>`. Cast through the
        // user-facing envelope shape — by-identity threading is the same
        // frozen reference all callbacks receive.
        const userBehavior = config.behavior as (args: {
            input: unknown;
            deps: Readonly<Record<string, unknown>>;
        }) => Promise<unknown>;
        actors[name] = fromPromise(async ({ input }) => userBehavior({ input, deps }));
    }
    return actors;
}
