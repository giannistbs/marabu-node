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

function printBlock(blockRow) {
  const { key, value } = blockRow;
  const txids = Array.isArray(value?.txids) ? value.txids.length : 0;
  const previd = typeof value?.previd === "string" ? value.previd : "n/a";
  const height = typeof value?.height === "number" ? value.height : "n/a";
  console.log(`- key=${key} height=${height} txids=${txids} previd=${previd}`);
}

try {
  const db = new Level(dbPath);
  const rows = await db.stream({ keys: true, values: true });
  const blocks = rows.filter((row) => row?.value?.type === "block");
  const sample = blocks.slice(0, LIMIT);

  console.log(`DB path: ${dbPath}`);
  console.log(`Blocks found: ${blocks.length}`);
  console.log(`Showing: ${sample.length}`);
  console.log("");

  for (const block of sample) {
    printBlock(block);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to read LevelDB at ${dbPath}`);
  console.error(message);
  console.error("Hint: stop docker node first if the DB is locked (docker compose down).");
  process.exit(1);
}
