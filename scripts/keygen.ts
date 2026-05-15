import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";

ed.hashes.sha512 = sha512;

const privateKey = ed.utils.randomSecretKey();
const publicKey = await ed.getPublicKeyAsync(privateKey);

console.log("private:", Buffer.from(privateKey).toString("hex"));
console.log("public: ", Buffer.from(publicKey).toString("hex"));