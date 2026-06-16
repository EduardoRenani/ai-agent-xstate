// Internal bucket sentinels for END lowering.
//
// Spec: docs/specs/008-compound-mode-routes.md §"Final substate injection —
// per outcome".
//
// Why a separate module: `lowerToIr` mints these sentinel *values* for the IR's
// `{ kind: "end", bucket }` targets, and `xstateBackend`'s translator consumes
// them to drive bucket-aware `$end_*` final injection/rewriting. This leaf
// module gives both sides one shared source.
//
// These symbols are wrapper-internal: they never surface in the user-facing
// API, never appear in `types.ts`, and are exhaustively rewritten to state
// names before `createMachine` ever sees a lowered shape.

export type EndBucket = "achieved" | "abandoned" | "error";

export const END_ACHIEVED: unique symbol = Symbol("atlas/END_achieved");
export const END_ABANDONED: unique symbol = Symbol("atlas/END_abandoned");
export const END_ERROR: unique symbol = Symbol("atlas/END_error");

export type EndBucketSymbol =
    | typeof END_ACHIEVED
    | typeof END_ABANDONED
    | typeof END_ERROR;

const BUCKET_BY_SYMBOL: ReadonlyMap<EndBucketSymbol, EndBucket> = new Map<
    EndBucketSymbol,
    EndBucket
>([
    [END_ACHIEVED, "achieved"],
    [END_ABANDONED, "abandoned"],
    [END_ERROR, "error"],
]);

const SYMBOL_BY_BUCKET: Readonly<Record<EndBucket, EndBucketSymbol>> = {
    achieved: END_ACHIEVED,
    abandoned: END_ABANDONED,
    error: END_ERROR,
};

export function bucketSymbol(outcome: EndBucket): EndBucketSymbol {
    return SYMBOL_BY_BUCKET[outcome];
}

export function bucketOf(sym: EndBucketSymbol): EndBucket {
    const out = BUCKET_BY_SYMBOL.get(sym);
    if (out === undefined) {
        throw new Error(`atlas/endBuckets: unknown bucket symbol ${String(sym)}`);
    }
    return out;
}

export function isBucketSymbol(value: unknown): value is EndBucketSymbol {
    return typeof value === "symbol" && BUCKET_BY_SYMBOL.has(value as EndBucketSymbol);
}
