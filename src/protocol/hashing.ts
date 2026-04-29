import { ApplicationObject } from "../types.js";
import { encodeApplicationObject } from "./codec.js";
import blake2 from "blake2";

// Computes the object ID (TxId or BlockId) of an application object by canonicalizing and hashing the object.
export function computeObjectId(object: ApplicationObject): string {

  let objectToHash: ApplicationObject = object;

  if (object.type === "blockwithmetadata") {
    objectToHash = object.block;
  }
  // Create a new Blake2s hash object.
  const h = blake2.createHash("blake2s");
  // Update the hash object with the encoded(canonicalized) application object.
  h.update(Buffer.from(encodeApplicationObject(objectToHash)));
  // Return the hash digest as a hexadecimal string.
  return h.digest("hex");
}
