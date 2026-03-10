import * as ed from "@noble/ed25519";
import { encodeTransactionSigningPayload } from "../codec.js";
import type { ApplicationObject, ErrorName, Transaction } from "../types.js";

/**
 * Interface representing a lookup service for already known application objects.
 * Used for looking up transactions (by their IDs) referenced by inputs.
 */
interface ObjectLookup {
  get(key: string): Promise<ApplicationObject>;
}

/**
 * Error thrown during application object semantic validation.
 * Includes an error name (for protocol-level error reporting) and a descriptive message.
 */
export class ApplicationObjectValidationError extends Error {
  constructor(
    public readonly errorName: ErrorName,
    message: string
  ) {
    super(message);
    this.name = "ApplicationObjectValidationError";
  }
}

/**
 * Verifies semantic rules of an ApplicationObject that require existing chain state.
 * For regular transactions, this checks signatures, referenced outputs, etc.
 * For coinbase transactions (which have a "height" field), no extra checks are needed.
 */
export async function validateApplicationObjectSemantics(
  object: ApplicationObject,
  objectLookup: ObjectLookup
): Promise<void> {
  // Coinbase transactions are valid by definition; only standard transactions need checks.
  if ("height" in object) {
    return;
  }
  // Standard transactions get validated for input signatures and referenced outputs.
  await validateTransactionSignatures(object, objectLookup);
}

/**
 * Validates all signatures and referenced outputs for every input in a transaction.
 * Throws an appropriate ApplicationObjectValidationError for each failure mode.
 */
async function validateTransactionSignatures(
  transaction: Transaction,
  objectLookup: ObjectLookup
): Promise<void> {
  // The signing payload is just the canonical encoding with all sigs nulled out.
  const signingPayload = encodeTransactionSigningPayload(transaction);

  // Validate each input for existence, reference, output, and signature correctness.
  for (let index = 0; index < transaction.inputs.length; index += 1) {
    const input = transaction.inputs[index];
    if (input === undefined) {
      // Should never happen in well-formed transactions.
      throw new ApplicationObjectValidationError(
        "INTERNAL_ERROR",
        `Missing transaction input at index ${index}`
      );
    }

    // Lookup the referenced transaction (for the output being spent).
    let referencedObject: ApplicationObject;
    try {
      referencedObject = await objectLookup.get(input.outpoint.txid);
    } catch {
      throw new ApplicationObjectValidationError(
        "INVALID_TX_OUTPOINT",
        `Referenced transaction ${input.outpoint.txid} is unknown`
      );
    }

    // Lookup the referenced output in that transaction.
    const referencedOutput = referencedObject.outputs[input.outpoint.index];
    if (referencedOutput === undefined) {
      throw new ApplicationObjectValidationError(
        "INVALID_TX_OUTPOINT",
        `Referenced output ${input.outpoint.txid}:${input.outpoint.index} is out of range`
      );
    }

    // Verify digital signature over the signing payload with referenced output's pubkey.
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
