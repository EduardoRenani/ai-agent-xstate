// Phase 5.14: target resolution validator (sibling-name only).
//
// Spec: docs/specs/004-tasks.md Phase 5.14,
// docs/specs/004-xstate-agent-wrapper.md §Target resolution (lines 824-829).
//
// Every `target` declared by the user — `routes.achieved[i].target`,
// `routes.abandoned[i].target`, `routes.error[i].target`, passive
// `on[event][i].target`, and a compound's `onDone` — must name a key in
// the **immediate enclosing** `states` map. The token symbols `END`
// (achieved/abandoned/error/onDone/passive-on) and `RE_THROW`
// (error only) pass through verbatim — they are resolved by slices 5.10
// (RE_THROW) and 5.11 ($end injection).
//
// String targets are additionally rejected when they:
//   - contain `.` (dotted paths like "socratic.teaching")
//   - start with `#` (XState absolute paths like "#agent.root")
//   - start with `.` (descendant paths — caught implicitly by the dot rule)
//
// On failure the validator throws a structured `Error` whose message names
// the offending leaf (or compound) path, the slot descriptor
// (`routes.achieved[0]`, `on.CLICK[1]`, `onDone`), and the literal bad
// target string — spec verification line 824.
//
// 5.14 ships the validator as a standalone toolkit. Wiring it into
// `defineAgent(...)` (so the throw fires on machine creation) is part of
// the final assembly slice (5.16) — same composition pattern as 5.11 and
// 5.13.

import { END, RE_THROW } from "./types.ts";

// Carrier shapes mirrored from walk.ts. Re-declared so the carrier-minting
// constructors stay the sole brand owners.
type LeafCarrier = {
    readonly __kind: "leaf";
    readonly config: Record<string, unknown>;
};
type CompoundCarrier = {
    readonly __kind: "compound";
    readonly config: {
        readonly states: Record<string, unknown>;
        readonly onDone: unknown;
    };
};

function joinPath(parent: string, name: string): string {
    return parent === "" ? name : `${parent}.${name}`;
}

function asCarrier(value: unknown, path: string): LeafCarrier | CompoundCarrier {
    if (typeof value !== "object" || value === null || !("__kind" in value)) {
        throw new Error(
            `atlas/validateTargets: state at "${path}" is not a LeafMode or Mode. ` +
                `Pass values constructed via defineLeafMode() or defineMode().`,
        );
    }
    const kind = (value as { __kind: unknown }).__kind;
    if (kind !== "leaf" && kind !== "compound") {
        throw new Error(
            `atlas/validateTargets: state at "${path}" has unknown kind ${String(kind)}`,
        );
    }
    return value as LeafCarrier | CompoundCarrier;
}

// Normalize a `T | readonly T[] | undefined` slot to a flat `readonly T[]`
// for uniform iteration.
function normalize(value: unknown): readonly unknown[] {
    if (value === undefined) return [];
    if (Array.isArray(value)) return value;
    return [value];
}

// Format error consistently — spec verification line 824 requires the path,
// slot descriptor, and literal target.
function fail(
    target: unknown,
    leafPath: string,
    slotDesc: string,
    reason: string,
): never {
    const literal = typeof target === "string" ? JSON.stringify(target) : String(target);
    throw new Error(
        `atlas/validateTargets: target ${literal} at "${leafPath}" in ${slotDesc}: ${reason}`,
    );
}

function checkTarget(
    target: unknown,
    siblings: readonly string[],
    leafPath: string,
    slotDesc: string,
): void {
    if (target === END || target === RE_THROW) return;
    if (typeof target !== "string") {
        fail(
            target,
            leafPath,
            slotDesc,
            `target must be a sibling name (string), END, or RE_THROW`,
        );
    }
    if (target.includes(".")) {
        fail(
            target,
            leafPath,
            slotDesc,
            `dotted paths are not accepted — END is the only way to exit a compound`,
        );
    }
    if (target.startsWith("#")) {
        fail(
            target,
            leafPath,
            slotDesc,
            `XState absolute paths (#-prefixed) are not accepted`,
        );
    }
    if (!siblings.includes(target)) {
        fail(
            target,
            leafPath,
            slotDesc,
            `no such sibling. Available siblings: ${JSON.stringify(siblings)}`,
        );
    }
}

function validateActiveLeaf(
    config: Record<string, unknown>,
    leafPath: string,
    siblings: readonly string[],
): void {
    const routes = (config.routes ?? {}) as Record<string, unknown>;
    const groups: readonly { key: "achieved" | "abandoned" | "error"; allowReThrow: boolean }[] = [
        { key: "achieved", allowReThrow: false },
        { key: "abandoned", allowReThrow: false },
        { key: "error", allowReThrow: true },
    ];
    for (const { key } of groups) {
        if (routes[key] === undefined) continue;
        const entries = normalize(routes[key]);
        for (let i = 0; i < entries.length; i += 1) {
            const target = (entries[i] as { target?: unknown }).target;
            checkTarget(target, siblings, leafPath, `routes.${key}[${i}]`);
        }
    }
    // `routes.retry` has no `target` field at the type level — skipped.
}

function validatePassiveLeaf(
    config: Record<string, unknown>,
    leafPath: string,
    siblings: readonly string[],
): void {
    const on = (config.on ?? {}) as Record<string, unknown>;
    for (const [event, transitions] of Object.entries(on)) {
        const list = normalize(transitions);
        for (let i = 0; i < list.length; i += 1) {
            const target = (list[i] as { target?: unknown }).target;
            // `on[event].target` is optional — a transition with only
            // `actions` is an internal/no-target action and is valid.
            if (target === undefined) continue;
            checkTarget(target, siblings, leafPath, `on.${event}[${i}]`);
        }
    }
}

function validateCompound(
    carrier: CompoundCarrier,
    compoundPath: string,
    siblings: readonly string[],
): void {
    checkTarget(carrier.config.onDone, siblings, compoundPath, "onDone");
}

// Public entry point. Recursively validates every `target` in the tree.
// Throws on the first violation — fail-fast surfaces the user's mistake at
// `defineAgent(...)` call time with full context.
export function validateTargets(
    states: Record<string, unknown>,
    parentPath: string = "",
): void {
    const siblings = Object.keys(states);
    for (const [name, value] of Object.entries(states)) {
        const path = joinPath(parentPath, name);
        const carrier = asCarrier(value, path);
        if (carrier.__kind === "leaf") {
            if ("behavior" in carrier.config && carrier.config.behavior !== undefined) {
                validateActiveLeaf(carrier.config, path, siblings);
            } else {
                validatePassiveLeaf(carrier.config, path, siblings);
            }
        } else {
            validateCompound(carrier, path, siblings);
            // Inner siblings = keys of THIS compound's `states` map.
            validateTargets(carrier.config.states, path);
        }
    }
}
