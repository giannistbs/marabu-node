import { ApplicationObject } from "../types.js";
import { encodeApplicationObject } from "./codec.js";
import blake2 from "blake2";

// Computes the object ID of an application object by canonicalizing and hashing the object.
export function computeObjectId(object: ApplicationObject): string {
  // Create a new Blake2s hash object.
  const h = blake2.createHash("blake2s");
  // Update the hash object with the encoded(canonicalized) application object.
  h.update(Buffer.from(encodeApplicationObject(object)));
  // Return the hash digest as a hexadecimal string.
  return h.digest("hex");
}
