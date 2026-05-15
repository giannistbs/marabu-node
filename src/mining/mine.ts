import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { encodeTransactionSigningPayload } from "../protocol/codec.js";
import {
  GENESIS_BLOCK,
  type Block,
} from "../types.js";
import { computeObjectId } from "../protocol/hashing.js";

const REQUIRED_BLOCK_TARGET =
  "00000000abc00000000000000000000000000000000000000000000000000000";
const BLOCK_REWARD = 50_000_000_000_000n;
const GENESIS_BLOCK_ID = computeObjectId(GENESIS_BLOCK);
const MISSING_BLOCK_TX_WAIT_MS = 3_500;
const MISSING_BLOCK_WAIT_MS = 4_500;


// Number of workers will be derived from env variables to be set depending on the machine
export async function spawnWorkers(block: Block, numOfWorkers: Number): Promise<Block> {

  // here we should kill all the existing workers and spawn new ones

    return workers.spawn(8, mineBlock(block))
}



export async function mineBlock(block: Block, step: Number): Promise<Block> {

    const targetValue = BigInt(`0x${REQUIRED_BLOCK_TARGET}`);
    let nonce = 0n;

    // run an infinite loop that alters block.nonce and only returns if computeObjectId(block) < T
    while (true) {
        block.nonce = nonce.toString(16).padStart(64, "0");
        nonce++;
        const blockId = computeObjectId(block);
        const blockValue = BigInt(`0x${blockId}`);
        if (blockValue < targetValue) {
          return block;
        }
    }
}