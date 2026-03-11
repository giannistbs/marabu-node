import { hashes } from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";

hashes.sha512 = sha512;
