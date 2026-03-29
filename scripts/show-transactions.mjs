#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import LevelModule from "level-ts/dist/Level.js";

const Level = typeof LevelModule === "function" ? LevelModule : LevelModule.default;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const dbPath = process.env.MARABU_OBJECT_STORE_PATH ?? path.join(repoRoot, "data", "object-store");
const LIMIT = 20;

function printTx(txRow) {
  const { key, value } = txRow;
  const inputCount = Array.isArray(value?.inputs) ? value.inputs.length : 0;
  const outputCount = Array.isArray(value?.outputs) ? value.outputs.length : 0;
  const height = typeof value?.height === "number" ? value.height : "n/a";
  console.log(`- key=${key} height=${height} inputs=${inputCount} outputs=${outputCount}`);
}

try {
  const db = new Level(dbPath);
  const rows = await db.stream({ keys: true, values: true });
  const transactions = rows.filter((row) => row?.value?.type === "transaction");
  const sample = transactions.slice(0, LIMIT);

  console.log(`DB path: ${dbPath}`);
  console.log(`Transactions found: ${transactions.length}`);
  console.log(`Showing: ${sample.length}`);
  console.log("");

  for (const tx of sample) {
    printTx(tx);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to read LevelDB at ${dbPath}`);
  console.error(message);
  console.error("Hint: stop docker node first if the DB is locked (docker compose down).");
  process.exit(1);
}
