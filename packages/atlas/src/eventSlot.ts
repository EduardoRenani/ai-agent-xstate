// SPEC 011 §Desugaring: "The `$event` slot is an internal context key written
// on the `$wait → $run` transition and read by `$run.invoke.input`."
//
// A self-suspending mode lowers to a mini-compound (`$run` / `$wait`). The
// waking event that re-activates a parked mode is stashed in this reserved
// root-context key so `$run.invoke.input` can hand it to the behavior. It is
// part of the snapshot (spec 009), so the stored event must be JSON
// serializable.
//
// Kept in its own leaf module (like `endBuckets.ts`) so both the leaf-build
// step that reads/writes it and any future consumer share one source without
// a value-import cycle.

export const EVENT_SLOT = "$event" as const;
export type EventSlotKey = typeof EVENT_SLOT;
