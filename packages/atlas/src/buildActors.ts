// Build the `actors` map for XState's `setup({ actors })`. Spec:
// docs/specs/004-tasks.md Phase 5.3 + docs/specs/004-xstate-agent-wrapper.md
// §Mapping. Spec 005: the wrapper closes over the agent's frozen `deps`
// reference and threads it into every active leaf's `behavior` callback.
//
// SPEC 011 §Desugaring: EVERY leaf now has a `behavior` and produces an actor
// (the active/passive split is gone). The actor's `input` is the `$run.invoke`
// envelope `{ userInput, event }` built by `buildActiveState.buildRunInput`:
// `userInput` is the user's derived input, `event` is the waking event read
// from the `$event` slot (`undefined` on a dry run / active entry). This wrapper
// unpacks it and calls `behavior({ input: userInput, event, deps })`.

import { fromPromiseActor, type CarrierActor } from "./xstateBackend.ts";

import { actorName } from "./actorName.ts";
import type { Slot } from "./walk.ts";

export function buildActors(
    slots: readonly Slot[],
    deps: Readonly<Record<string, unknown>>,
): Record<string, CarrierActor> {
    const actors: Record<string, CarrierActor> = {};
    for (const slot of slots) {
        if (slot.kind !== "leaf") continue;
        const config = slot.config;
        // SPEC 011: every leaf has a `behavior` → every leaf produces an actor.
        if (!("behavior" in config)) continue;

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
        // `defineMode` call site; the internal carrier here erases that
        // generic to the default `Record<string, never>`. Cast through the
        // user-facing envelope shape — by-identity threading is the same
        // frozen reference all callbacks receive.
        const userBehavior = config.behavior as (args: {
            input: unknown;
            event: unknown;
            deps: Readonly<Record<string, unknown>>;
        }) => Promise<unknown>;
        // The `$run.invoke.input` envelope is `{ userInput, event }`. Unpack it
        // and thread the waking `event` through to the behavior (SPEC 011).
        actors[name] = fromPromiseActor(async ({ input }) => {
            const envelope = input as { userInput: unknown; event: unknown };
            return userBehavior({
                input: envelope.userInput,
                event: envelope.event,
                deps,
            });
        });
    }
    return actors;
}
