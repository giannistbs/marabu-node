import * as ed from "@noble/ed25519";
import { encodeTransactionSigningPayload } from "../codec.js";
import type { ApplicationObject, ErrorName, Transaction } from "../types.js";
import {
  isNonNegativeInteger,
  isValidEd25519PublicKey
} from "./utils.js";

// Interface for looking up application objects by ID.
interface ObjectLookup {
  get(key: string): Promise<ApplicationObject>;
}
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

// Validates protocol rules for an application object that require chain state.
export async function validateApplicationObjectState(
  object: ApplicationObject,
  objectLookup: ObjectLookup
): Promise<void> {
  if ("height" in object) {
    validateOutputs(object.outputs);
    return;
  }
  await validateTransactionState(object, objectLookup);
}

// Validates input signatures and referenced outputs for a transaction.
async function validateTransactionState(
  transaction: Transaction,
  objectLookup: ObjectLookup
): Promise<void> {
  const signingPayload = encodeTransactionSigningPayload(transaction);
  validateOutputs(transaction.outputs);
  await validateTransactionInputSignatures(
    transaction,
    objectLookup,
    signingPayload
  );
  await validateTransactionConservation(transaction, objectLookup);
}


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

    const outputRecord = output as Record<string, unknown>;
    const pubkey = outputRecord.pubkey;
    if (typeof pubkey !== "string") {
      throw new ApplicationObjectValidationError(
        "INVALID_FORMAT",
        `${context} output ${index} has an invalid public key`
      );
    }
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
    if (!isNonNegativeInteger(value)) {
      throw new ApplicationObjectValidationError(
        "INVALID_FORMAT",
        `${context} output ${index} has an invalid value`
      );
    }
  }
}

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

    let referencedObject: ApplicationObject;
    try {
      referencedObject = await objectLookup.get(input.outpoint.txid);
    } catch (error: unknown) {
      if (!isMissingReferencedObjectError(error)) {
        throw error;
      }

      throw new ApplicationObjectValidationError(
        "UNKNOWN_OBJECT",
        `Referenced transaction ${input.outpoint.txid} is unknown`
      );
    }

    const referencedOutput = referencedObject.outputs[input.outpoint.index];
    if (referencedOutput === undefined) {
      throw new ApplicationObjectValidationError(
        "INVALID_TX_OUTPOINT",
        `Referenced output ${input.outpoint.txid}:${input.outpoint.index} is out of range`
      );
    }

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

async function validateTransactionConservation(
  transaction: Transaction,
  objectLookup: ObjectLookup
): Promise<void> {
  let inputTotal = 0;
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
      referencedObject = await objectLookup.get(input.outpoint.txid);
    } catch (error: unknown) {
      if (!isMissingReferencedObjectError(error)) {
        throw error;
      }

      throw new ApplicationObjectValidationError(
        "UNKNOWN_OBJECT",
        `Referenced transaction ${input.outpoint.txid} is unknown`
      );
    }

    const referencedOutput = referencedObject.outputs[input.outpoint.index];
    if (referencedOutput === undefined) {
      throw new ApplicationObjectValidationError(
        "INVALID_TX_OUTPOINT",
        `Referenced output ${input.outpoint.txid}:${input.outpoint.index} is out of range`
      );
    }

    inputTotal += referencedOutput.value;
  }

  let outputTotal = 0;
  for (const output of transaction.outputs) {
    outputTotal += output.value;
  }

  if (inputTotal < outputTotal) {
    throw new ApplicationObjectValidationError(
      "INVALID_TX_CONSERVATION",
      "Transaction violates conservation"
    );
  }
}


function isMissingReferencedObjectError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    "notFound" in error && error.notFound === true
  ) || error.name === "NotFoundError";
}
