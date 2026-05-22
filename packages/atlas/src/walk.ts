// Tree walk over an agent's `modes` map.
//
// Spec: docs/specs/004-tasks.md Phase 5.1.
//
// Enumerates every `LeafMode` and `Mode` slot, recording a root-relative
// dotted path. The path is used only inside `compile.ts` (for actor naming,
// for target resolution, for error messages); it is never exposed to users.

import type { LeafModeConfig } from "./types.ts";

// Internal carrier shapes. Mirrored from `defineLeafMode.ts` /
// `defineMode.ts`. Repeated here (not imported) so the constructor modules
// remain the sole owners of the brand-minting cast — `walk.ts` only reads
// the runtime shape.
type LeafCarrier = {
    readonly __kind: "leaf";
    readonly config: LeafModeConfig<unknown, { type: string }, unknown>;
};
type CompoundCarrier = {
    readonly __kind: "compound";
    readonly config: { readonly modes: Record<string, unknown> };
};

export type LeafSlot = {
    readonly kind: "leaf";
    readonly path: string;
    readonly config: LeafModeConfig<unknown, { type: string }, unknown>;
};

export type CompoundSlot = {
    readonly kind: "compound";
    readonly path: string;
    readonly config: { readonly modes: Record<string, unknown> };
};

export type Slot = LeafSlot | CompoundSlot;

function asCarrier(value: unknown, path: string): LeafCarrier | CompoundCarrier {
    if (typeof value !== "object" || value === null || !("__kind" in value)) {
        throw new Error(
            `atlas/walk: state at "${path}" is not a LeafMode or Mode. ` +
                `Pass values constructed via defineLeafMode() or defineMode().`,
        );
    }
    const kind = (value as { __kind: unknown }).__kind;
    if (kind !== "leaf" && kind !== "compound") {
        throw new Error(`atlas/walk: state at "${path}" has unknown kind ${String(kind)}`);
    }
    return value as LeafCarrier | CompoundCarrier;
}

export function walk(
    modes: Record<string, unknown>,
    parentPath = "",
): Slot[] {
    const slots: Slot[] = [];
    for (const [key, value] of Object.entries(modes)) {
        const path = parentPath === "" ? key : `${parentPath}.${key}`;
        const carrier = asCarrier(value, path);
        if (carrier.__kind === "leaf") {
            slots.push({ kind: "leaf", path, config: carrier.config });
        } else {
            slots.push({ kind: "compound", path, config: carrier.config });
            slots.push(...walk(carrier.config.modes, path));
        }
    }
    return slots;
}
