import "dotenv/config";
import * as readline from "node:readline/promises";
import { createAgentActor } from "./machine.js";

const actor = createAgentActor();
actor.start();

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

function waitForReady(): Promise<void> {
    return new Promise((resolve) => {
        if (actor.getSnapshot().can({ type: "MESSAGE", text: "" })) {
            resolve();
            return;
        }
        const sub = actor.subscribe((snapshot) => {
            if (snapshot.can({ type: "MESSAGE", text: "" })) {
                sub.unsubscribe();
                resolve();
            }
        });
    });
}

async function main() {
    console.log("AI Agent started. Type a message to begin.\n");

    while (true) {
        const line = await rl.question("> ");
        const text = line.trim();
        if (!text) continue;

        actor.send({ type: "MESSAGE", text });
        await waitForReady();
    }
}

rl.on("close", () => {
    actor.stop();
    process.exit(0);
});

main();
