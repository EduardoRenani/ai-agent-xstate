// Phase 5.15: route shape runtime validator — belt-and-suspenders for the
// `RouteList<E>` constraint.
//
// Spec: docs/specs/004-tasks.md Phase 5.15,
// docs/specs/004-xstate-agent-wrapper.md verification line 821.
//
// The type system already enforces `RouteList<E>` at every call site:
//   - `achieved` / `abandoned` / `error` reject the empty array `[]`
//   - non-last array entries must carry `when` (otherwise they shadow later
//     entries — first-match-wins at runtime would skip everything after)
//   - the last array entry must NOT carry `when` (it is the unguarded
//     default; without it no fallback fires).
//
// A user can bypass these checks with `as Routes<...>`. This validator
// re-checks the same invariants at machine-creation time and throws a
// structured error naming the leaf path, the slot (`achieved` / `retry` /
// `abandoned` / `error`), and the offending index — spec verification
// line 821.
//
// Scope is intentionally narrow:
//   - shape only (array vs. scalar, length, presence of `when`)
//   - target resolution stays in `validateTargets` (5.14)
//   - field-level shape (`target` missing on an ExitEntry, `assign` not a
//     function, etc.) is out of scope for this slice; the type system
//     remains the primary guard for those.
//
// Like 5.14, this slice ships the validator standalone. Slice 5.16 wires
// it into `defineAgent(...)` so the throw fires on machine creation.

type RouteSlot = "achieved" | "retry" | "abandoned" | "error";

type LeafCarrier = {
    readonly __kind: "leaf";
    readonly config: Record<string, unknown>;
};
type CompoundCarrier = {
    readonly __kind: "compound";
    readonly config: {
        readonly modes: Record<string, unknown>;
    };
};

function joinPath(parent: string, name: string): string {
    return parent === "" ? name : `${parent}.${name}`;
}

function asCarrier(value: unknown, path: string): LeafCarrier | CompoundCarrier {
    if (typeof value !== "object" || value === null || !("__kind" in value)) {
        throw new Error(
            `atlas/validateRoutes: state at "${path}" is not a Mode or CompoundMode. ` +
                `Pass values constructed via defineMode() or defineCompoundMode().`,
        );
    }
    const kind = (value as { __kind: unknown }).__kind;
    if (kind !== "leaf" && kind !== "compound") {
        throw new Error(
            `atlas/validateRoutes: state at "${path}" has unknown kind ${String(kind)}`,
        );
    }
    return value as LeafCarrier | CompoundCarrier;
}

function fail(leafPath: string, slot: RouteSlot, index: number | null, reason: string): never {
    const where = index === null ? `routes.${slot}` : `routes.${slot}[${index}]`;
    throw new Error(`atlas/validateRoutes: ${where} at "${leafPath}": ${reason}`);
}

function validateRouteListShape(
    slot: RouteSlot,
    value: unknown,
    leafPath: string,
): void {
    if (value === undefined) {
        if (slot === "error") return; // optional
        fail(
            leafPath,
            slot,
            null,
            `required outcome is missing (declare an entry with \`target\` or, for retry, supply \`[]\`)`,
        );
    }
    if (!Array.isArray(value)) {
        // Scalar form — single-default. Field-level shape (target, when,
        // assign) is the type system's responsibility; we only verify it
        // is at least an object.
        if (typeof value !== "object" || value === null) {
            fail(
                leafPath,
                slot,
                null,
                `must be an object or array (got ${typeof value})`,
            );
        }
        return;
    }

    const arr = value as readonly { when?: unknown }[];
    if (arr.length === 0) {
        if (slot === "retry") return; // explicit empty retry = no-op default
        fail(
            leafPath,
            slot,
            null,
            `must not be the empty array []. Provide a single default entry, or guarded entries followed by a default.`,
        );
    }

    // Non-last entries MUST carry `when` — without it they shadow every
    // entry after them at first-match-wins runtime.
    for (let i = 0; i < arr.length - 1; i += 1) {
        if (arr[i].when === undefined) {
            fail(
                leafPath,
                slot,
                i,
                `non-last entry is missing \`when\` — it would shadow later entries at runtime (first-match-wins)`,
            );
        }
    }

    // Last entry MUST NOT carry `when` — the last entry is the unguarded
    // default; otherwise no fallback exists when every preceding `when`
    // returns false.
    const lastIndex = arr.length - 1;
    const last = arr[lastIndex];
    if (last !== undefined && last.when !== undefined) {
        fail(
            leafPath,
            slot,
            lastIndex,
            `last entry carries \`when\` — the last entry must be the unguarded default`,
        );
    }
}

function validateActiveLeafRoutes(
    config: Record<string, unknown>,
    leafPath: string,
): void {
    const routes = (config.routes ?? {}) as Record<string, unknown>;
    validateRouteListShape("achieved", routes.achieved, leafPath);
    validateRouteListShape("retry", routes.retry, leafPath);
    validateRouteListShape("abandoned", routes.abandoned, leafPath);
    validateRouteListShape("error", routes.error, leafPath);
}

// Public entry point. Recursively validates `routes` shape on every active
// leaf in the tree. Passive leaves are skipped (no `routes` field).
export function validateRoutes(
    modes: Record<string, unknown>,
    parentPath: string = "",
): void {
    for (const [name, value] of Object.entries(modes)) {
        const path = joinPath(parentPath, name);
        const carrier = asCarrier(value, path);
        if (carrier.__kind === "leaf") {
            if ("behavior" in carrier.config && carrier.config.behavior !== undefined) {
                validateActiveLeafRoutes(carrier.config, path);
            }
        } else {
            validateRoutes(carrier.config.modes, path);
        }
    }
}
