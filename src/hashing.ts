import { ApplicationObject } from "./types.js";
import { encodeApplicationObject } from "./codec.js";
import blake2 from "blake2";

export function computeObjectId(object: ApplicationObject): string {
  const h = blake2.createHash("blake2s");
  h.update(encodeApplicationObject(object));
  return h.digest("hex");
}