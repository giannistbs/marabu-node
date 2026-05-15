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



export async function spawnWorkers(block: Block): Promise<Block> {

    return workers.spawn(8, mineBlock(block))
}



export async function mineBlock(block: Block): Promise<Block> {

    block.nonce = (1).toString()
    const targetValue = BigInt(`0x${REQUIRED_BLOCK_TARGET}`);

    // run an infinite loop that alters block.nonce and only returns if computeObjectId(block) < T
    while (true) {
        block.nonce = (Number(block.nonce) + 1).toString();
        const blockId = computeObjectId(block);
        const blockValue = BigInt(`0x${blockId}`);
        if (blockValue < targetValue) {
          return block;
        }
    }
}