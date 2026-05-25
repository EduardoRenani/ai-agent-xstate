// Rewrite relative `.ts` / `.tsx` import specifiers to `.js` in emitted .d.ts.
//
// Workaround for a TypeScript 5.9 bug: `rewriteRelativeImportExtensions: true`
// rewrites extensions in emitted `.js` correctly, but leaves `.ts` / `.tsx` in
// emitted `.d.ts`. That breaks consumers — only `.d.ts` + `.js` ship under
// `files`, so `from "./types.ts"` resolves to nothing in a consumer's tsc.
//
// Tightly scoped: only rewrites the specifier inside `from "..."` / `import "..."`
// / `import("...")` when the specifier starts with `./` or `../` AND ends in
// `.ts` / `.tsx`. Leaves bare specifiers, deep imports of other packages, and
// non-`.ts` extensions untouched.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = resolve(__dirname, "..", "dist");

/** @param {string} dir */
async function* walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            yield* walk(full);
        } else if (entry.isFile() && full.endsWith(".d.ts")) {
            yield full;
        }
    }
}

const SPECIFIER_RE = /(from\s+|import\s+|import\()(["'])(\.{1,2}\/[^"']*?)\.tsx?\2/g;

let changed = 0;
for await (const file of walk(DIST_DIR)) {
    const before = await readFile(file, "utf8");
    const after = before.replace(SPECIFIER_RE, (_m, kw, q, spec) => `${kw}${q}${spec}.js${q}`);
    if (after !== before) {
        await writeFile(file, after);
        changed += 1;
    }
}

console.log(`fix-dts-extensions: rewrote ${changed} declaration file(s)`);
