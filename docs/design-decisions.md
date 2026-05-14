# Design Decisions

## 001 — No cross-boundary sub-state targeting

**Date:** 2026-05-14

**Rule:** Transitions must never target a child sub-state of another compound state. Always target the parent and let it route internally via its `initial` state.

**Problem:** If `greetings` targets `#agent.improvise.thinking` directly, it knows `improvise`'s internal structure. Reorganizing `improvise`'s children silently breaks `greetings`.

**Solution:** Design the compound state's `initial` to match the expected entry behavior. In `improvise`, the initial state is `thinking` (not `listening`) because every entry arrives with a user message already in context, ready to process. This way `greetings` targets `"improvise"` (the parent) and the compound state handles routing internally.

**Rejected alternative:** Using an `always` guard in the child state to re-route on entry. This moves the coupling to the target — the child carries routing logic that only exists to serve the source. The guard has nothing to do with the child's own responsibility.
