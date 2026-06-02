// Thin terminal loop. Each iteration loads the session snapshot from disk,
// runs one turn, writes the new snapshot back. The actor is constructed and
// disposed inside `runTurn`; the only thing that crosses turns is the JSON
// payload on disk — same shape as a production HTTP / queue consumer storing
// session state in a DB. Compound `local` slots (e.g. socratic's
// `evalRetries`) survive across turns because the snapshot round-trips
// through JSON.stringify / JSON.parse, not because anything is held in
// memory.
import "dotenv/config";
import * as readline from "node:readline/promises";

import { loadSession, saveSession } from "./sessionStore.js";
import { runTurn } from "./turn.js";

// Fixed id keeps the example single-tenant. A real host would derive this
// from the request (user id, channel id, etc.).
const SESSION_ID = "default";

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

async function main() {
    const resumed = await loadSession(SESSION_ID);
    if (resumed) {
        console.log(`Resumed session "${SESSION_ID}" from disk.\n`);
    } else {
        console.log("AI Agent started. Type a message to begin.\n");
    }

    while (true) {
        const line = await rl.question("> ");
        const text = line.trim();
        if (!text) continue;

        const previous = await loadSession(SESSION_ID);
        const result = await runTurn(text, previous, SESSION_ID);
        if (result.ok) {
            await saveSession(SESSION_ID, result.snapshot);
        } else {
            // Fire-and-log fallback: the previous snapshot is untouched, so
            // the next message restarts from the last-good `listening`. The
            // escape was already logged by `runTurn`'s `onError` hook.
            console.log("Agent error — please try again.\n");
        }
    }
}

rl.on("close", () => {
    process.exit(0);
});

main();
