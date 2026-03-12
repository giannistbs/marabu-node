import canonicalizeImport from "canonicalize";
import type { AnyMessage, ApplicationObject, Transaction } from "./types.js";
import {
  MessageValidationError,
  validateWireMessage
} from "./validation/messageSchema.js";

const canonicalize = canonicalizeImport as unknown as (
  input: unknown
) => string | undefined;
const textEncoder = new TextEncoder();

// Canonicalizes and serializes a message as one newline-delimited JSON frame.
export function encodeMessage(message: AnyMessage): string {
  // Canonical JSON ensures deterministic wire encoding for equivalent payloads.
  const encoded = canonicalize(message);
  if (typeof encoded !== "string") {
    throw new Error("Unable to canonicalize message");
  }

  return `${encoded}\n`;
}

export function encodeApplicationObject(object: ApplicationObject): string {
    // Canonical JSON ensures deterministic wire encoding for equivalent payloads.
    const encoded = canonicalize(object);
    if (typeof encoded !== "string") {
      throw new Error("Unable to canonicalize message");
    }
  
    return `${encoded}`;
}

// Canonicalizes a transaction with all signatures nulled for signature verification.
export function encodeTransactionSigningPayload(
  transaction: Transaction
): Uint8Array {
  const payload = {
    ...transaction,
    inputs: transaction.inputs.map((input) => ({
      ...input,
      sig: null
    }))
  };
  const encoded = canonicalize(payload);
  if (typeof encoded !== "string") {
    throw new Error("Unable to canonicalize signing payload");
  }

  return textEncoder.encode(encoded);
}

// Parses one newline-delimited frame and validates it as a protocol message.
export function decodeLine(line: string): AnyMessage {
  let parsed: unknown;
  try {
    // Parse raw JSON first so validation can focus on schema correctness.
    parsed = JSON.parse(line);
  } catch {
    throw new MessageValidationError("Message is not valid JSON");
  }

  // Enforce protocol-level validation and return a typed message shape.
  return validateWireMessage(parsed);
}
