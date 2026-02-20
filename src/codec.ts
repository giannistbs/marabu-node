import canonicalizeImport from "canonicalize";
import type { AnyMessage } from "./types.js";
import { MessageValidationError, validateMessage } from "./validation.js";

const canonicalize = canonicalizeImport as unknown as (
  input: unknown
) => string | undefined;

// Canonicalizes and serializes a message as one newline-delimited JSON frame.
export function encodeMessage(message: AnyMessage): string {
  // Canonical JSON ensures deterministic wire encoding for equivalent payloads.
  const encoded = canonicalize(message);
  if (typeof encoded !== "string") {
    throw new Error("Unable to canonicalize message");
  }

  return `${encoded}\n`;
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
  return validateMessage(parsed);
}
