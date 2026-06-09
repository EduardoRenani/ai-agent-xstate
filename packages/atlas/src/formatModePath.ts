// `formatModePath` — render XState's nested `value` shape as an Atlas-
// vocabulary mode-path string.
//
// Spec: docs/specs/009-snapshot-aware-rehydration.md §`AgentInspectionEvent`
//        + §Clarification 6 (dot-only separator; throw on parallel regions).
//
// Lifted from the inline `formatStateValue` that used to live in
// `examples/zoe/src/machine.ts:42-50`, with one defensive change: Atlas does
// not lower to parallel regions, so a value with more than one key here is
// a wrapper invariant violation and we throw instead of joining with `, `.

/**
 * Walk XState's nested mode-value shape and return a dot-joined Atlas
 * mode-path. Strings pass through unchanged. Nested objects representing a
 * compound's active substate are recursed into. Parallel regions (an object
 * with more than one key) are not produced by Atlas's lowering, so we treat
 * them as a wrapper invariant violation and throw.
 *
 * @param value  Either a leaf-mode name (`string`) or a nested compound
 *               value (`{ [parent]: childValue }`).
 * @returns      A dot-joined path, e.g. `"socratic.teaching"` or
 *               `"listening"`.
 * @throws       If `value` is an object with more than one key — Atlas does
 *               not currently lower to XState parallel regions, so this
 *               indicates either a future change or a bug.
 */
export function formatModePath(value: unknown): string {
    if (typeof value === "string") return value;
    if (typeof value !== "object" || value === null) {
        return String(value);
    }
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length !== 1) {
        throw new Error(
            `formatModePath: Atlas does not lower to parallel regions; ` +
                `got value with ${entries.length} keys (${entries.map(([k]) => k).join(", ")})`,
        );
    }
    const entry = entries[0];
    if (entry === undefined) return "";
    // SPEC 011 Clarification #6: a self-suspending mode lowers to a mini-compound
    // with synthetic substates (`$run`/`$wait`/`$end_*`). MASK those synthetic
    // segments to just the mode name — a parked mode reports `foo`, not
    // `foo.$wait`; a running one `foo`, not `foo.$run`. Readiness ("parked vs
    // running") is surfaced explicitly via `AgentInspectionEvent.awaiting`
    // instead of being inferred from the path. Real nested compounds (children
    // whose names don't start with `$`) recurse unchanged.
    const child = entry[1];
    if (typeof child === "string" && child.startsWith("$")) {
        return entry[0];
    }
    return `${entry[0]}.${formatModePath(child)}`;
}
