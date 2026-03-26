import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { encodeApplicationObject, encodeTransactionSigningPayload } from "../protocol/codec.js";
import type { ApplicationObject, Block, ErrorName, Output, Transaction, UtxoEntry, UtxoSnapshot } from "../types.js";
import {
  isNonNegativeInteger,
  isValidEd25519PublicKey
} from "./utils.js";
import { computeObjectId } from "../protocol/hashing.js";


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

  // ensureTarget(block); // ensure the target is our specified hardcoded target (00000000abc00000000000000000000000000000000000000000000000000000) send INVALID_FORMAT if error


  // await checkPOW(); // should send INVALID_BLOCK_POW if error


  // await checkTxsExistence() // this should also send a message to get missing TXids. after waiting for a while if you dont receive them, send back UNFINDABLE_OBJECT if unfound


  // // in checkCoinbaseTxs we should check that at most there is one coinbase and it should be at index 0 in txids, send INVALID_BLOCK_COINBASE otherwise
  // checkCoinbaseTxPosition()

  // checkCoinbaseTxSpending() // the coinbase tx cannot be spent in another tx in the same block, send INVALID_TX_OUTPOINT otherwise


  // await validateTxsAndUpdateUTXO() // this should also send UNFINDABLE_OBJECT if a tx can not be validated

  // // this should check that the coinbase tx has no inputs, exactly one output and a height, for the height and the public key they should be of the valid format
  // // verify the law of conservation for th ecoinbase tx, the output of the coinbase tx can be at most the sum of tx fees in the block + the block reward. the block reward
  // // is a constant of 50*10^12 picabu. the fee of the tx is the sum of its input values minus the sum of its output values. send INVALID_BLOCK_COINBASE error otherwise
  // await validateCoinbaseTx()


}

async function validateTxsAndUpdateUTXO(
  block: Block,
  objectLookup: ObjectLookup
): Promise<UtxoSnapshot> {
  // first we should initialize the utxo set to the utxo set of the parent (previd)

  const parentUtxo: UtxoSnapshot = await objectLookup.getUtxo(block.previd as string);

  // We will construct the following for faster lookups
  const workingUtxo = new Map<string, UtxoEntry>();
  for (const entry of parentUtxo.entries) {
    workingUtxo.set(`${entry.outpoint.txid}:${entry.outpoint.index}`, entry);
  }


  // Now update the Utxo Set
  for (const txid of block.txids) {
    const transaction  = await objectLookup.getObject(txid);

    if (transaction.type !== "transaction") {
      throw new ApplicationObjectValidationError(
        "INVALID_TX_OUTPOINT",
        `Referenced object ${txid} is not a transaction`
      );
    }

    // Flow for regular Txs
    if (!("height" in transaction)) {


      const signingPayload = encodeTransactionSigningPayload(transaction);
      // Step 1
      validateOutputs(transaction.outputs);
      // Step 2
      const referencedOutputs = resolveOutpointsFromUtxo(transaction, workingUtxo);
      // Step 3
      await validateTransactionInputSignatures(
        transaction,
        referencedOutputs,
        signingPayload
      );
      // Step 4
      validateTransactionConservation(transaction, referencedOutputs);



      // inputs -- delete
      for (const input of transaction.inputs) {
        workingUtxo.delete(`${input.outpoint.txid}:${input.outpoint.index}`);
      }

      // outputs -- add
      for (const [outputIndex, output] of transaction.outputs.entries()) {
        workingUtxo.set(`${txid}:${outputIndex}`, {
          outpoint: { txid: txid, index: outputIndex },
          output
        });
      }


    } else {
      // Flow for coinbase txs
      const coinbaseOutput = transaction.outputs[0];
      if (coinbaseOutput === undefined) {
        throw new ApplicationObjectValidationError(
          "INVALID_BLOCK_COINBASE",
          `Coinbase transaction ${txid} is missing its first output`
        );
      }
      workingUtxo.set(`${txid}:0`, {
        outpoint: { txid: txid, index: 0 },
        output: coinbaseOutput
      });
    }


  }

  // then for each tx in the block:
    //  we should validate it as per the existing logic -> validateTransactionState()
    // additionally we should check that each input of the tx corresponds to an output that is present in the utxo set
    // ie the output exists and it has not been spent yet
    // if the output is not present, send back INVALID_TX_OUTPOINT

    // then we should apply the tx by removing the UTXOs that are spent and adding the UTXOs that are created
  
  // we repeat the previous for all txs using the updated utxo set

  // for now we can assume that the previous block was sent to as beforehand

  const snapshot: UtxoSnapshot = {
    entries: [...workingUtxo.values()]
  };
  await objectLookup.putUtxo(computeObjectId(block), snapshot)
  return snapshot
}


// Resolves each input's outpoint to the referenced output from the current UTXO map.
function resolveOutpointsFromUtxo(
  transaction: Transaction,
  utxoMap: Map<string, UtxoEntry>
): Output[] {
  const referencedOutputs: Output[] = [];

  for (let index = 0; index < transaction.inputs.length; index += 1) {
    const input = transaction.inputs[index];
    if (input === undefined) {
      throw new ApplicationObjectValidationError(
        "INTERNAL_ERROR",
        `Missing transaction input at index ${index}`
      );
    }

    const key = `${input.outpoint.txid}:${input.outpoint.index}`;
    const entry = utxoMap.get(key);
    if (entry === undefined) {
      throw new ApplicationObjectValidationError(
        "INVALID_TX_OUTPOINT",
        `Referenced output ${key} is not in the UTXO set`
      );
    }

    referencedOutputs.push(entry.output);
  }

  return referencedOutputs;
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
  const referencedOutputs = await resolveOutpoints(transaction, objectLookup);

  // Step 3
  await validateTransactionInputSignatures(
    transaction,
    referencedOutputs,
    signingPayload
  );

  // Step 4
  validateTransactionConservation(transaction, referencedOutputs);
}


// Resolves each input's outpoint to the referenced output, performing existence and type checks.
async function resolveOutpoints(
  transaction: Transaction,
  objectLookup: ObjectLookup
): Promise<Output[]> {
  const referencedOutputs: Output[] = [];

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

    referencedOutputs.push(referencedOutput);
  }

  return referencedOutputs;
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
  referencedOutputs: Output[],
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

    const referencedOutput = referencedOutputs[index]!;

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
function validateTransactionConservation(
  transaction: Transaction,
  referencedOutputs: Output[]
): void {
  let inputTotal = 0n;
  for (const referencedOutput of referencedOutputs) {
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
  getUtxo(blockId: string): Promise<UtxoSnapshot>;
  putUtxo(blockId: string, snapshot: UtxoSnapshot): Promise<void> ;
}
