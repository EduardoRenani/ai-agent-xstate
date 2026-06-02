// File-backed session store — the persistence boundary the spec 009 contract
// crosses. Each turn:
//   1. `loadSession(id)` reads `<id>.json`, JSON.parses it, returns the
//      typed `AgentSnapshot`. First call returns `undefined` (no file yet)
//      and the agent boots from `initial`.
//   2. `runTurn` rebuilds the actor from that snapshot, runs one turn,
//      returns the new snapshot.
//   3. `saveSession(id, snapshot)` JSON.stringifies and writes the snapshot
//      back to disk.
//
// This shape mirrors a production HTTP / queue consumer that stores session
// state in a DB: the snapshot is the *only* thing that crosses process
// boundaries between turns. If `local` survives the round-trip here, it
// survives anywhere — that is the contract spec 009 §Persistence Contract
// makes.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";

import type { AgentSnapshot } from "@eduardorenani/atlasjs";

import type { AgentContext } from "./types.js";

// Sessions live under .zoe-sessions/ in cwd. Gitignored at the repo root.
const SESSIONS_DIR = path.join(process.cwd(), ".zoe-sessions");

function sessionPath(id: string): string {
    return path.join(SESSIONS_DIR, `${id}.json`);
}

/**
 * Read a session snapshot from disk, or `undefined` if no file exists yet.
 *
 * The JSON.parse result is cast to `AgentSnapshot<AgentContext>` — that's
 * the trust boundary. If a future `atlasVersion` bump introduces a different
 * shape, gate restoration behind a check on `loaded.atlasVersion` here.
 */
export async function loadSession(
    id: string,
): Promise<AgentSnapshot<AgentContext> | undefined> {
    try {
        const raw = await readFile(sessionPath(id), "utf8");
        return JSON.parse(raw) as AgentSnapshot<AgentContext>;
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw err;
    }
}

/**
 * Serialize the snapshot and write it to disk. JSON-only on purpose — the
 * `AgentSnapshot` brand is type-only, so `JSON.stringify` round-trips it
 * without custom encoding.
 */
export async function saveSession(
    id: string,
    snapshot: AgentSnapshot<AgentContext>,
): Promise<void> {
    await mkdir(SESSIONS_DIR, { recursive: true });
    await writeFile(
        sessionPath(id),
        JSON.stringify(snapshot, null, 2),
        "utf8",
    );
}
