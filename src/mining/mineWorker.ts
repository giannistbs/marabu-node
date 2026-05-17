import { workerData, parentPort } from "node:worker_threads";
import { computeObjectId } from "../protocol/hashing.js";
import { REQUIRED_BLOCK_TARGET } from "./mine.js";
import type { Block } from "../types.js";

const { block, step, workerSlot }: { block: Block; step: number; workerSlot: number } = workerData;

const targetValue = BigInt(`0x${REQUIRED_BLOCK_TARGET}`);
let nonce = BigInt(workerSlot);

// run an infinite loop that alters block.nonce and only returns if computeObjectId(block) < T
while (true) {
    block.nonce = nonce.toString(16).padStart(64, "0");
    nonce += BigInt(step);
    const blockId = computeObjectId(block);
    const blockValue = BigInt(`0x${blockId}`);
    if (blockValue < targetValue) {
        parentPort!.postMessage(block);
        break;
    }
}
