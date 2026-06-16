// SPEC 012 §Seam 3 / §Verification — XState containment boundary tripwire.
//
// Spec: docs/specs/012-xstate-containment.md §Verification ("a lint/CI grep
//       asserting `from \"xstate\"` appears only in `xstateBackend.ts` and
//       `startAgent.ts` under `src/`").
//
// DD-033: below `startAgent`, exactly one module may know XState's vocabulary
// (`xstateBackend.ts`). This test fails the moment any other `src/` module
// imports from `xstate` — the tripwire for a future engine swap and for
// accidental re-coupling.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const ALLOWED = new Set(["xstateBackend.ts", "startAgent.ts"]);

function tsFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...tsFiles(full));
        else if (entry.name.endsWith(".ts")) out.push(full);
    }
    return out;
}

describe("XState containment boundary (DD-033)", () => {
    test('only xstateBackend.ts and startAgent.ts import from "xstate"', () => {
        const offenders = tsFiles(SRC)
            .filter((file) => /from\s+["']xstate["']/.test(readFileSync(file, "utf8")))
            .map((file) => file.slice(SRC.length + 1))
            .filter((rel) => !ALLOWED.has(rel))
            .sort();
        expect(offenders).toEqual([]);
    });
});
