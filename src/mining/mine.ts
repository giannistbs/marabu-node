import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  GENESIS_BLOCK,
  type Block,
} from "../types.js";
import { computeObjectId } from "../protocol/hashing.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const REQUIRED_BLOCK_TARGET =
  "00000000abc00000000000000000000000000000000000000000000000000000";
const BLOCK_REWARD = 50_000_000_000_000n;
const GENESIS_BLOCK_ID = computeObjectId(GENESIS_BLOCK);
const MISSING_BLOCK_TX_WAIT_MS = 3_500;
const MISSING_BLOCK_WAIT_MS = 4_500;


let activeWorkers: Worker[] = [];

// Number of workers will be derived from env variables to be set depending on the machine
export async function spawnMiningWorkers(block: Block, numOfWorkers: number): Promise<Block> {

  // kill all existing workers before spawning new ones
  for (const worker of activeWorkers) {
    worker.terminate();
  }
  activeWorkers = [];

  const workerPromises: Promise<Block>[] = [];
  for (let i = 0; i < numOfWorkers; i++) {
    const worker = new Worker(join(__dirname, "mineWorkerBoot.mjs"), {
      workerData: { block: { ...block }, step: numOfWorkers, workerSlot: i }
    });
    activeWorkers.push(worker);
    workerPromises.push(new Promise<Block>((resolve, reject) => {
      worker.on("message", resolve);
      worker.on("error", reject);
    }));
  }

  const winner = await Promise.race(workerPromises);

  for (const worker of activeWorkers) {
    worker.terminate();
  }
  activeWorkers = [];

  return winner;
}