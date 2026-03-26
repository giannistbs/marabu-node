import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { encodeTransactionSigningPayload } from "../protocol/codec.js";
import { computeObjectId } from "../protocol/hashing.js";
import type {
  ApplicationObject,
  Block,
  CoinbaseTransaction,
  ErrorName,
  Transaction,
  UtxoSnapshot
} from "../types.js";
import {
  isNonNegativeInteger,
  isValidEd25519PublicKey
} from "./utils.js";

const REQUIRED_BLOCK_TARGET =
  "00000000abc00000000000000000000000000000000000000000000000000000";


  /*//////////////////////////////////////////////////////////////
                        PUBLIC VALIDATION
  //////////////////////////////////////////////////////////////*/

// Validates protocol rules for an application object that require chain state.
export async function validateApplicationObjectState(
  object: ApplicationObject,
  objectLookup: ObjectLookup
): Promise<void> {

  if (object.type === "transaction") {
    if ("height" in object) {
      validateOutputs(object.outputs);
      return;
    }
    await validateTransactionState(object, objectLookup);
  } else if (object.type === "block") {
    await validateBlockState(object, objectLookup);
  }
  return;

}

  /*//////////////////////////////////////////////////////////////
                        BLOCK VALIDATION
  //////////////////////////////////////////////////////////////*/

// Validates input signatures and referenced outputs for a transaction.
async function validateBlockState(
  block: Block,
  objectLookup: ObjectLookup
): Promise<void> {

  ensureTarget(block); // ensure the target is our specified hardcoded target (00000000abc00000000000000000000000000000000000000000000000000000) send INVALID_FORMAT if error

  checkPOW(block); // should send INVALID_BLOCK_POW if error

  await checkTxsExistence() // this should also send a message to get missing TXids. after waiting for a while if you dont receive them, send back UNFINDABLE_OBJECT if unfound

  // in checkCoinbaseTxs we should check that at most there is one coinbase and it should be at index 0 in txids, send INVALID_BLOCK_COINBASE otherwise
  await checkCoinbaseTxPosition(block, objectLookup)

  await checkCoinbaseTxSpending(block, objectLookup) // the coinbase tx cannot be spent in another tx in the same block, send INVALID_TX_OUTPOINT otherwise

  await validateTxsAndUpdateUTXO() // this should also send UNFINDABLE_OBJECT if a tx can not be validated

  // this should check that the coinbase tx has no inputs, exactly one output and a height, for the height and the public key they should be of the valid format
  // verify the law of conservation for th ecoinbase tx, the output of the coinbase tx can be at most the sum of tx fees in the block + the block reward. the block reward
  // is a constant of 50*10^12 picabu. the fee of the tx is the sum of its input values minus the sum of its output values. send INVALID_BLOCK_COINBASE error otherwise
  await validateCoinbaseTx()
}

async function validateTxsAndUpdateUTXO(
  block: Block,
  objectLookup: ObjectLookup
): Promise<UtxoSnapshot> {
  // first we should initialize the utxo set to the utxo set of the parent (previd)

  // then for each tx in the block:
    //  we should validate it as per the existing logic -> validateTransactionState()
    // additionally we should check that each input of the tx corresponds to an output that is present in the utxo set
    // ie the output exists and it has not been spent yet
    // if the output is not present, send back INVALID_TX_OUTPOINT

    // then we should apply the tx by removing the UTXOs that are spent and adding the UTXOs that are created
  
  // we repeat the previous for all txs using the updated utxo set

  // for now we can assume that the previous block was sent to as beforehand
}

  /*//////////////////////////////////////////////////////////////
                     TRANSACTION VALIDATION
  //////////////////////////////////////////////////////////////*/

// Validates input signatures and referenced outputs for a transaction.
async function validateTransactionState(
  transaction: Transaction,
  objectLookup: ObjectLookup
): Promise<void> {
  const signingPayload = encodeTransactionSigningPayload(transaction);

  // Step 1
  validateOutputs(transaction.outputs);

  // Step 2
  await validateTransactionInputSignatures(
    transaction,
    objectLookup,
    signingPayload
  );

  // Step 3
  await validateTransactionConservation(transaction, objectLookup);
}


// Validates that each output has a valid Ed25519 pubkey and a non-negative integer value.
function validateOutputs(outputs: unknown): void {
  const context = "transaction";
  if (!Array.isArray(outputs)) {
    throw new ApplicationObjectValidationError(
      "INVALID_FORMAT",
      `${context}.outputs must be an array`
    );
  }

  for (let index = 0; index < outputs.length; index += 1) {
    const output = outputs[index];
    if (output === undefined || output === null || typeof output !== "object") {
      throw new ApplicationObjectValidationError(
        "INVALID_FORMAT",
        `${context} output ${index} must be an object`
      );
    }

    // Cast to a record so we can access pubkey/value without a concrete type.
    const outputRecord = output as Record<string, unknown>;
    const pubkey = outputRecord.pubkey;
    if (typeof pubkey !== "string") {
      throw new ApplicationObjectValidationError(
        "INVALID_FORMAT",
        `${context} output ${index} has an invalid public key`
      );
    }
    // Checks the key is a valid 32-byte hex-encoded Ed25519 public key.
    if (!isValidEd25519PublicKey(pubkey)) {
      throw new ApplicationObjectValidationError(
        "INVALID_FORMAT",
        `${context} output ${index} has an invalid public key`
      );
    }

    const value = outputRecord.value;
    if (typeof value !== "number") {
      throw new ApplicationObjectValidationError(
        "INVALID_FORMAT",
        `${context} output ${index} has an invalid value`
      );
    }
    // Fractional or negative values are not allowed; amounts are in whole picabu.
    if (!isNonNegativeInteger(value)) {
      throw new ApplicationObjectValidationError(
        "INVALID_FORMAT",
        `${context} output ${index} has an invalid value`
      );
    }
  }
}

// Verifies that every input's sig is a valid Ed25519 signature over the signing payload,
// using the pubkey from the referenced output.
async function validateTransactionInputSignatures(
  transaction: Transaction,
  objectLookup: ObjectLookup,
  signingPayload: Uint8Array
): Promise<void> {
  for (let index = 0; index < transaction.inputs.length; index += 1) {
    const input = transaction.inputs[index];
    if (input === undefined) {
      throw new ApplicationObjectValidationError(
        "INTERNAL_ERROR",
        `Missing transaction input at index ${index}`
      );
    }

    // Resolve the transaction that created the output being spent.
    let referencedObject: ApplicationObject;
    try {
      referencedObject = await objectLookup.getObject(input.outpoint.txid);
    } catch (error: unknown) {
      if (!isMissingReferencedObjectError(error)) {
        throw error;
      }

      throw new ApplicationObjectValidationError(
        "UNKNOWN_OBJECT",
        `Referenced transaction ${input.outpoint.txid} is unknown`
      );
    }

    if (referencedObject.type !== "transaction") {
      throw new ApplicationObjectValidationError(
        "INVALID_TX_OUTPOINT",
        `Referenced object ${input.outpoint.txid} is not a transaction`
      );
    }

    // Ensure the output index is within bounds of the referenced transaction's outputs.
    const referencedOutput = referencedObject.outputs[input.outpoint.index];
    if (referencedOutput === undefined) {
      throw new ApplicationObjectValidationError(
        "INVALID_TX_OUTPOINT",
        `Referenced output ${input.outpoint.txid}:${input.outpoint.index} is out of range`
      );
    }

    // The signing payload covers all outputs and inputs (with sigs set to null),
    // so the signature commits to the full transaction structure.
    const isValidSignature = await ed.verifyAsync(
      ed.etc.hexToBytes(input.sig),
      signingPayload,
      ed.etc.hexToBytes(referencedOutput.pubkey)
    );
    if (!isValidSignature) {
      throw new ApplicationObjectValidationError(
        "INVALID_TX_SIGNATURE",
        `Transaction input ${index} has an invalid signature`
      );
    }
  }
}

// Ensures the sum of input values is >= the sum of output values (no coins created out of thin air).
// The difference (fee) may be claimed by a miner via the coinbase transaction.
async function validateTransactionConservation(
  transaction: Transaction,
  objectLookup: ObjectLookup
): Promise<void> {
  let inputTotal = 0n;
  for (let index = 0; index < transaction.inputs.length; index += 1) {
    const input = transaction.inputs[index];
    if (input === undefined) {
      throw new ApplicationObjectValidationError(
        "INTERNAL_ERROR",
        `Missing transaction input at index ${index}`
      );
    }

    let referencedObject: ApplicationObject;
    try {
      referencedObject = await objectLookup.getObject(input.outpoint.txid);
    } catch (error: unknown) {
      if (!isMissingReferencedObjectError(error)) {
        throw error;
      }

      throw new ApplicationObjectValidationError(
        "UNKNOWN_OBJECT",
        `Referenced transaction ${input.outpoint.txid} is unknown`
      );
    }

    if (referencedObject.type !== "transaction") {
      throw new ApplicationObjectValidationError(
        "INVALID_TX_OUTPOINT",
        `Referenced object ${input.outpoint.txid} is not a transaction`
      );
    }

    const referencedOutput = referencedObject.outputs[input.outpoint.index];
    if (referencedOutput === undefined) {
      throw new ApplicationObjectValidationError(
        "INVALID_TX_OUTPOINT",
        `Referenced output ${input.outpoint.txid}:${input.outpoint.index} is out of range`
      );
    }

    inputTotal += BigInt(referencedOutput.value);
  }

  let outputTotal = 0n;
  for (const output of transaction.outputs) {
    outputTotal += BigInt(output.value);
  }

  // Strict inequality: outputs may be less than inputs (fee), but never more.
  if (inputTotal < outputTotal) {
    throw new ApplicationObjectValidationError(
      "INVALID_TX_CONSERVATION",
      "Transaction violates conservation"
    );
  }
}


  /*//////////////////////////////////////////////////////////////
                        PRIVATE HELPERS
  //////////////////////////////////////////////////////////////*/

function isMissingReferencedObjectError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    "notFound" in error && error.notFound === true
  ) || error.name === "NotFoundError";
}

function ensureTarget(block: Block): void {
  if (block.T !== REQUIRED_BLOCK_TARGET) {
    throw new ApplicationObjectValidationError(
      "INVALID_FORMAT",
      "Block target is incorrect"
    );
  }
}

function checkPOW(block: Block): void {
  const blockId = computeObjectId(block);
  const blockValue = BigInt(`0x${blockId}`);
  const targetValue = BigInt(`0x${block.T}`);

  if (blockValue >= targetValue) {
    throw new ApplicationObjectValidationError(
      "INVALID_BLOCK_POW",
      "Block does not satisfy proof of work"
    );
  }
}

async function checkCoinbaseTxPosition(
  block: Block,
  objectLookup: ObjectLookup
): Promise<void> {
  let coinbaseIndex: number | null = null;

  for (let index = 0; index < block.txids.length; index += 1) {
    const txid = block.txids[index];
    if (txid === undefined) {
      throw new ApplicationObjectValidationError(
        "INTERNAL_ERROR",
        `Missing block txid at index ${index}`
      );
    }

    const transaction = await getBlockTransaction(txid, objectLookup);
    if (!isCoinbaseTransaction(transaction)) {
      continue;
    }

    if (coinbaseIndex !== null) {
      throw new ApplicationObjectValidationError(
        "INVALID_BLOCK_COINBASE",
        "Block contains more than one coinbase transaction"
      );
    }

    coinbaseIndex = index;
  }

  if (coinbaseIndex !== null && coinbaseIndex !== 0) {
    throw new ApplicationObjectValidationError(
      "INVALID_BLOCK_COINBASE",
      "Coinbase transaction must be at index 0"
    );
  }
}

async function checkCoinbaseTxSpending(
  block: Block,
  objectLookup: ObjectLookup
): Promise<void> {
  const coinbaseTxid = block.txids[0];
  if (coinbaseTxid === undefined) {
    return;
  }

  const firstTransaction = await getBlockTransaction(coinbaseTxid, objectLookup);
  if (!isCoinbaseTransaction(firstTransaction)) {
    return;
  }

  for (let index = 1; index < block.txids.length; index += 1) {
    const txid = block.txids[index];
    if (txid === undefined) {
      throw new ApplicationObjectValidationError(
        "INTERNAL_ERROR",
        `Missing block txid at index ${index}`
      );
    }

    const transaction = await getBlockTransaction(txid, objectLookup);
    if (isCoinbaseTransaction(transaction)) {
      continue;
    }

    for (const input of transaction.inputs) {
      if (input.outpoint.txid === coinbaseTxid) {
        throw new ApplicationObjectValidationError(
          "INVALID_TX_OUTPOINT",
          "Coinbase transaction cannot be spent in the same block"
        );
      }
    }
  }
}

async function getBlockTransaction(
  txid: string,
  objectLookup: ObjectLookup
): Promise<Transaction | CoinbaseTransaction> {
  let referencedObject: ApplicationObject;
  try {
    referencedObject = await objectLookup.getObject(txid);
  } catch (error: unknown) {
    if (!isMissingReferencedObjectError(error)) {
      throw error;
    }

    throw new ApplicationObjectValidationError(
      "UNFINDABLE_OBJECT",
      `Block references unknown transaction ${txid}`
    );
  }

  if (referencedObject.type !== "transaction") {
    throw new ApplicationObjectValidationError(
      "UNFINDABLE_OBJECT",
      `Block reference ${txid} is not a transaction`
    );
  }

  return referencedObject;
}

function isCoinbaseTransaction(
  transaction: Transaction | CoinbaseTransaction
): transaction is CoinbaseTransaction {
  return "height" in transaction;
}





  /*//////////////////////////////////////////////////////////////
                            TYPES
  //////////////////////////////////////////////////////////////*/

// Error type for application object validation failures that require chain state.
export class ApplicationObjectValidationError extends Error {
  constructor(
    public readonly errorName: ErrorName,
    message: string
  ) {
    super(message);
    this.name = "ApplicationObjectValidationError";
  }
}

// This exists because @noble/ed25519 needs sha512 plugged in before signatures work.
ed.hashes.sha512 = sha512;

// Interface for looking up application objects by ID.
interface ObjectLookup {
  getObject(key: string): Promise<ApplicationObject>;
  getUtxo(blockId: string): Promise<UtxoSnapshot>
}
