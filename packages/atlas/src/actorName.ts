// Derive the XState actor name for an active `LeafMode` from its
// root-relative path. Spec: docs/design-decisions.md DD-008 — actor names
// are `<camelCase(path)>Node`. Encoding the convention as code (here) makes
// DD-008 an invariant enforced by the compiler, not a hand-maintained rule.
//
// Examples:
//   "listening"             → "listeningNode"
//   "classifying"           → "classifyingNode"
//   "socratic.evaluating"   → "socraticEvaluatingNode"
//   "greetings.thinking"    → "greetingsThinkingNode"

export function actorName(path: string): string {
    if (path === "") {
        throw new Error("atlas/actorName: empty path");
    }
    const segments = path.split(".");
    if (segments.some((s) => s === "")) {
        throw new Error(`atlas/actorName: malformed path "${path}" (empty segment)`);
    }
    const camel = segments
        .map((seg, i) => (i === 0 ? seg : seg.charAt(0).toUpperCase() + seg.slice(1)))
        .join("");
    return `${camel}Node`;
}
