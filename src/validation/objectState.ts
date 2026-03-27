import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { encodeTransactionSigningPayload } from "../protocol/codec.js";
import { computeObjectId } from "../protocol/hashing.js";
import {
  GENESIS_BLOCK,
  type ApplicationObject,
  type Block,
  type CoinbaseTransaction,
  type ErrorName,
  type Output,
  type Transaction,
  type UtxoEntry,
  type UtxoSnapshot
} from "../types.js";
import {
  isNonNegativeInteger,
  isValidEd25519PublicKey
} from "./utils.js";

const REQUIRED_BLOCK_TARGET =
  "00000000abc00000000000000000000000000000000000000000000000000000";
const BLOCK_REWARD = 50_000_000_000_000n;
const GENESIS_BLOCK_ID = computeObjectId(GENESIS_BLOCK);


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
  ensureTarget(block);
  checkPOW(block);
  ensureGenesis(block);
  await checkTxsExistence(block, objectLookup)
  const coinbaseTxid = await checkCoinbaseTxPosition(block, objectLookup)
  await checkCoinbaseTxSpending(block, objectLookup, coinbaseTxid)
  const { snapshot, totalFees } = await validateTxsAndUpdateUTXO(block, objectLookup)
  await validateCoinbaseTx(block, objectLookup, totalFees)
  await objectLookup.putUtxo(computeObjectId(block), snapshot)
}

async function checkTxsExistence(
  block: Block,
  objectLookup: ObjectLookup
): Promise<void> {
  const missingTxids: string[] = []

  for (const txid of block.txids) {
    try {
      const object = await objectLookup.getObject(txid)
      if (object.type !== "transaction") {
        throw new ApplicationObjectValidationError(
          "UNFINDABLE_OBJECT",
          `Block reference ${txid} is not a transaction`
        )
      }
    } catch (error: unknown) {
      if (!isMissingReferencedObjectError(error)) {
        throw error
      }

      objectLookup.requestObject(txid)
      missingTxids.push(txid)
    }
  }

  if (missingTxids.length === 0) {
    return
  }

  await wait(3500)

  for (const txid of missingTxids) {
    try {
      const object = await objectLookup.getObject(txid)
      if (object.type !== "transaction") {
        throw new ApplicationObjectValidationError(
          "UNFINDABLE_OBJECT",
          `Block reference ${txid} is not a transaction`
        )
      }
    } catch (error: unknown) {
      if (!isMissingReferencedObjectError(error)) {
        throw error
      }

      throw new ApplicationObjectValidationError(
        "UNFINDABLE_OBJECT",
        `Referenced transaction ${txid} could not be found`
      )
    }
  }
}

async function validateTxsAndUpdateUTXO(
  block: Block,
  objectLookup: ObjectLookup
): Promise<{ snapshot: UtxoSnapshot; totalFees: bigint }> {
  // first we should initialize the utxo set to the utxo set of the parent (previd)
  if (block.previd === null) {
    return buildUpdatedUtxo(block, { entries: [] }, objectLookup);
  }

  let parentUtxo: UtxoSnapshot;
  try {
    parentUtxo = await objectLookup.getUtxo(block.previd);
  } catch (error: unknown) {
    if (!isMissingReferencedObjectError(error)) {
      throw error;
    }

    throw new MissingParentBlockError(
      `Missing parent UTXO for block ${computeObjectId(block)}`
    );
  }

  return buildUpdatedUtxo(block, parentUtxo, objectLookup);
}

async function buildUpdatedUtxo(
  block: Block,
  parentUtxo: UtxoSnapshot,
  objectLookup: ObjectLookup
): Promise<{ snapshot: UtxoSnapshot; totalFees: bigint }> {
  // We will construct the following for faster lookups
  const workingUtxo = new Map<string, UtxoEntry>();
  for (const entry of parentUtxo.entries) {
    workingUtxo.set(`${entry.outpoint.txid}:${entry.outpoint.index}`, entry);
  }

  let totalFees = 0n;


  // Now update the Utxo Set
  for (const txid of block.txids) {
    const transaction  = await objectLookup.getObject(txid);

    if (transaction.type !== "transaction") {
      throw new ApplicationObjectValidationError(
        "UNFINDABLE_OBJECT",
        `Referenced object ${txid} is not a transaction`
      );
    }

    // Flow for regular Txs
    if (!("height" in transaction)) {
      let referencedOutputs: Output[];
      try {
        const signingPayload = encodeTransactionSigningPayload(transaction);
        // Step 1
        validateOutputs(transaction.outputs);
        // Step 2
        referencedOutputs = resolveOutpointsFromUtxo(transaction, workingUtxo);
        // Step 3
        await validateTransactionInputSignatures(
          transaction,
          referencedOutputs,
          signingPayload
        );
        // Step 4
        validateTransactionConservation(transaction, referencedOutputs);
      } catch (error: unknown) {
        throw remapInvalidBlockTransactionError(txid, error);
      }

      totalFees += calculateTransactionFeeFromOutputs(
        transaction,
        referencedOutputs
      );



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

  const snapshot: UtxoSnapshot = {
    entries: [...workingUtxo.values()]
  };
  return { snapshot, totalFees }
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

function ensureTarget(block: Block): void {
  if (block.T !== REQUIRED_BLOCK_TARGET) {
    throw new ApplicationObjectValidationError(
      "INVALID_FORMAT",
      "Block target is incorrect"
    );
  }
}

function ensureGenesis(block: Block): void {
  if (block.previd !== null) {
    return;
  }

  if (computeObjectId(block) !== GENESIS_BLOCK_ID) {
    throw new ApplicationObjectValidationError(
      "INVALID_GENESIS",
      "Only the genesis block may have a null previd"
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
): Promise<string | null> {
  let coinbaseIndex: number | null = null;
  let coinbaseTxid: string | null = null;

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
    coinbaseTxid = txid;
  }

  if (coinbaseIndex !== null && coinbaseIndex !== 0) {
    throw new ApplicationObjectValidationError(
      "INVALID_BLOCK_COINBASE",
      "Coinbase transaction must be at index 0"
    );
  }

  return coinbaseTxid;
}

async function checkCoinbaseTxSpending(
  block: Block,
  objectLookup: ObjectLookup,
  coinbaseTxid: string | null
): Promise<void> {
  if (coinbaseTxid === null) {
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

async function validateCoinbaseTx(
  block: Block,
  objectLookup: ObjectLookup,
  totalFees: bigint
): Promise<void> {
  const coinbaseTxid = block.txids[0];
  if (coinbaseTxid === undefined) {
    return;
  }

  const firstTransaction = await getBlockTransaction(coinbaseTxid, objectLookup);
  if (!isCoinbaseTransaction(firstTransaction)) {
    return;
  }

  if ("inputs" in firstTransaction) {
    throw new ApplicationObjectValidationError(
      "INVALID_FORMAT",
      "Coinbase transaction must not contain inputs"
    );
  }

  if (!isNonNegativeInteger(firstTransaction.height)) {
    throw new ApplicationObjectValidationError(
      "INVALID_FORMAT",
      "Coinbase transaction height is invalid"
    );
  }

  if (firstTransaction.outputs.length !== 1) {
    throw new ApplicationObjectValidationError(
      "INVALID_FORMAT",
      "Coinbase transaction must have exactly one output"
    );
  }

  validateOutputs(firstTransaction.outputs);

  const coinbaseOutput = firstTransaction.outputs[0];
  if (coinbaseOutput === undefined) {
    throw new ApplicationObjectValidationError(
      "INVALID_FORMAT",
      "Coinbase transaction must have exactly one output"
    );
  }

  const maximumCoinbaseValue = BLOCK_REWARD + totalFees;
  if (BigInt(coinbaseOutput.value) > maximumCoinbaseValue) {
    throw new ApplicationObjectValidationError(
      "INVALID_BLOCK_COINBASE",
      "Coinbase transaction claims more than the block reward plus fees"
    );
  }
}

function calculateTransactionFeeFromOutputs(
  transaction: Transaction,
  referencedOutputs: Output[]
): bigint {
  let inputTotal = 0n;
  for (const referencedOutput of referencedOutputs) {
    inputTotal += BigInt(referencedOutput.value);
  }

  let outputTotal = 0n;
  for (const output of transaction.outputs) {
    outputTotal += BigInt(output.value);
  }

  return inputTotal - outputTotal;
}

function remapInvalidBlockTransactionError(
  txid: string,
  error: unknown
): unknown {
  if (!(error instanceof ApplicationObjectValidationError)) {
    return error;
  }

  switch (error.errorName) {
    case "INVALID_FORMAT":
    case "INVALID_TX_SIGNATURE":
    case "INVALID_TX_CONSERVATION":
    case "UNKNOWN_OBJECT":
      return new ApplicationObjectValidationError(
        "UNFINDABLE_OBJECT",
        `Block contains invalid transaction ${txid}`
      );
    default:
      return error;
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

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
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

export class MissingParentBlockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingParentBlockError";
  }
}

// This exists because @noble/ed25519 needs sha512 plugged in before signatures work.
ed.hashes.sha512 = sha512;

// Interface for looking up application objects by ID.
interface ObjectLookup {
  getObject(key: string): Promise<ApplicationObject>;
  getUtxo(blockId: string): Promise<UtxoSnapshot>;
  putUtxo(blockId: string, snapshot: UtxoSnapshot): Promise<void>;
  requestObject(objectId: string): void;
}
