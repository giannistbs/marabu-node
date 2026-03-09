declare module "blake2" {
  interface Blake2Hash {
    update(data: string | Uint8Array): Blake2Hash;
    digest(encoding: "hex"): string;
    digest(): Buffer;
  }

  interface Blake2Module {
    createHash(algorithm: "blake2s" | "blake2b"): Blake2Hash;
  }

  const blake2: Blake2Module;
  export default blake2;
}
