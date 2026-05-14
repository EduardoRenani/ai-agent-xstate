# Project rules

## TypeScript

- **No `any`.** Never use `any` in type annotations, casts, or generics. If you cannot find a proper type, stop and ask for explicit permission — explain what you tried and why you cannot type it correctly.
- **Strict nulls.** `strictNullChecks` is always on. Never suppress null/undefined checks with `!` (non-null assertion) unless the safety is proven and commented.

## Formatting

- Indent with **4 spaces** (tabs are spaces, tab width = 4).

## Specs

- Spec index lives at `docs/specs/README.md`.
