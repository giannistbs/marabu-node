const ED25519_PUBLIC_KEY_PATTERN = /^[a-f0-9]{64}$/;

export function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function isValidEd25519PublicKey(value: string): boolean {
  return ED25519_PUBLIC_KEY_PATTERN.test(value);
}
