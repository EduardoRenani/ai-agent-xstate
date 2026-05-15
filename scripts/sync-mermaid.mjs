#!/usr/bin/env node
// Syncs ```mermaid fences in README.md from .mmd source files referenced via marker comments.
//
// Marker format in README.md:
//
//   <!-- mermaid-source: relative/path/to/file.mmd -->
//   ```mermaid
//   ...replaced content...
//   ```
//   <!-- /mermaid-source -->
//
// Source of truth is the .mmd file. README's fence is regenerated to match it.

import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const readmePath = resolve(repoRoot, "README.md");

const MARKER_OPEN = /^<!--\s*mermaid-source:\s*(\S+)\s*-->\s*$/;
const MARKER_CLOSE = "<!-- /mermaid-source -->";
const FENCE_OPEN = "```mermaid";
const FENCE_CLOSE = "```";

function fail(message, lineNum) {
    throw new Error(`sync-mermaid: ${message} (README.md line ${lineNum + 1})`);
}

async function sync() {
    const content = await readFile(readmePath, "utf-8");
    const lines = content.split("\n");
    const out = [];
    let i = 0;
    let blocks = 0;

    while (i < lines.length) {
        const line = lines[i];
        const match = MARKER_OPEN.exec(line);
        if (!match) {
            out.push(line);
            i++;
            continue;
        }

        out.push(line);
        const sourceRel = match[1];
        const sourceAbs = resolve(repoRoot, sourceRel);
        const sourceContent = (await readFile(sourceAbs, "utf-8")).replace(/\s+$/, "");

        // Expect: optional blank lines, then ```mermaid.
        i++;
        while (i < lines.length && lines[i].trim() === "") {
            out.push(lines[i]);
            i++;
        }
        if (i >= lines.length || lines[i].trim() !== FENCE_OPEN) {
            fail(`expected ${FENCE_OPEN} after marker for ${sourceRel}`, i);
        }
        out.push(FENCE_OPEN);
        i++;

        // Skip everything until ``` (the original fence content is discarded).
        while (i < lines.length && lines[i].trim() !== FENCE_CLOSE) {
            i++;
        }
        if (i >= lines.length) {
            fail(`expected ${FENCE_CLOSE} to end mermaid fence for ${sourceRel}`, i);
        }
        i++;

        // Insert source content between the fence markers.
        for (const srcLine of sourceContent.split("\n")) {
            out.push(srcLine);
        }
        out.push(FENCE_CLOSE);

        // Expect: optional blank lines, then <!-- /mermaid-source -->.
        while (i < lines.length && lines[i].trim() === "") {
            out.push(lines[i]);
            i++;
        }
        if (i >= lines.length || lines[i].trim() !== MARKER_CLOSE) {
            fail(`expected ${MARKER_CLOSE} to close block for ${sourceRel}`, i);
        }
        out.push(lines[i]);
        i++;
        blocks++;
    }

    const next = out.join("\n");
    if (next !== content) {
        await writeFile(readmePath, next);
        console.log(`sync-mermaid: updated README.md (${blocks} block${blocks === 1 ? "" : "s"})`);
        return { changed: true, blocks };
    }
    console.log(`sync-mermaid: already in sync (${blocks} block${blocks === 1 ? "" : "s"})`);
    return { changed: false, blocks };
}

sync().catch((err) => {
    console.error(err.message);
    process.exit(1);
});
