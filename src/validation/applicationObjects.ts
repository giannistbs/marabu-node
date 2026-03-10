import * as ed from "@noble/ed25519";
import { encodeTransactionSigningPayload } from "../codec.js";
import type { ApplicationObject, ErrorName, Transaction } from "../types.js";

interface ObjectLookup {
  get(key: string): Promise<ApplicationObject>;
}

export class ApplicationObjectValidationError extends Error {
  constructor(
    public readonly errorName: ErrorName,
    message: string
  ) {
    super(message);
    this.name = "ApplicationObjectValidationError";
  }
}

// Verifies semantic rules that require existing chain state.
export async function validateApplicationObjectSemantics(
  object: ApplicationObject,
  objectLookup: ObjectLookup
): Promise<void> {
  if ("height" in object) {
    return;
  }

  await validateTransactionSignatures(object, objectLookup);
}

async function validateTransactionSignatures(
  transaction: Transaction,
  objectLookup: ObjectLookup
): Promise<void> {
  const signingPayload = encodeTransactionSigningPayload(transaction);

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
    } catch {
      throw new ApplicationObjectValidationError(
        "INVALID_TX_OUTPOINT",
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
