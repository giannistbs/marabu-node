const ED25519_PUBLIC_KEY_PATTERN = /^[a-f0-9]{64}$/;

export function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function isValidEd25519PublicKey(value: string): boolean {
  return ED25519_PUBLIC_KEY_PATTERN.test(value);
}

// Base error class for all schema/validation failures.
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export type RecordValue = Record<string, unknown>;

// Type guard for plain JSON object payloads.
export function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Asserts that a value is a plain object before field-level validation.
export function assertRecord(value: unknown, errorMessage: string): RecordValue {
  if (!isRecord(value)) {
    throw new ValidationError(errorMessage);
  }

  return value;
}

// Asserts that a field is a string and returns the narrowed value.
export function assertString(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new ValidationError(`${fieldName} must be a string`);
  }

  return value;
}

// Asserts that a field is a finite number and returns the narrowed value.
export function assertNumber(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationError(`${fieldName} must be a number`);
  }

  return value;
}

// Asserts that a field is a non-negative integer.
export function assertNonNegativeInteger(value: unknown, fieldName: string): number {
  const number = assertNumber(value, fieldName);
  if (!isNonNegativeInteger(number)) {
    throw new ValidationError(`${fieldName} must be a non-negative integer`);
  }

  return number;
}

// Enforces an exact key set with required and optional fields.
export function assertExactKeys(
  objectValue: RecordValue,
  requiredKeys: string[],
  optionalKeys: string[] = []
): void {
  // Reject unknown keys to keep message formats strict.
  const allowed = new Set<string>([...requiredKeys, ...optionalKeys]);

  for (const key of Object.keys(objectValue)) {
    if (!allowed.has(key)) {
      throw new ValidationError(`Unexpected key '${key}'`);
    }
  }

  // Require every expected key to be explicitly present.
  for (const key of requiredKeys) {
    if (!Object.hasOwn(objectValue, key)) {
      throw new ValidationError(`Missing required key '${key}'`);
    }
  }
}
