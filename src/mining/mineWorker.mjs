import { workerData, parentPort } from "node:worker_threads";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const canonicalize = require("canonicalize");
const blake2 = require("blake2");

function computeObjectId(object) {
  const encoded = canonicalize(object);
  const h = blake2.createHash("blake2s");
  h.update(Buffer.from(encoded));
  return h.digest("hex");
}

const { block, step, workerSlot, target } = workerData;

const targetValue = BigInt(`0x${target}`);
let nonce = BigInt(workerSlot);

while (true) {
  block.nonce = nonce.toString(16).padStart(64, "0");
  nonce += BigInt(step);
  const blockId = computeObjectId(block);
  const blockValue = BigInt(`0x${blockId}`);
  if (blockValue < targetValue) {
    parentPort.postMessage(block);
    break;
  }
}
