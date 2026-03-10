import type {
  AnyMessage,
  ErrorMessage,
  GetObjectMessage,
  GetPeersMessage,
  HelloMessage,
  IHaveObjectMessage,
  PeersMessage,
  Transaction,
  CoinbaseTransaction,
  ObjectMessage,
  Input,
  Output,
  ApplicationObject,
  OutPoint
} from "../types.js";

const HELLO_VERSION_PATTERN = /^0\.10\.\d+$/;

type RecordValue = Record<string, unknown>;

export class MessageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MessageValidationError";
  }
}

// Type guard for plain JSON object payloads.
function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Asserts that a value is a plain object before field-level validation.
function assertRecord(value: unknown, errorMessage: string): RecordValue {
  if (!isRecord(value)) {
    throw new MessageValidationError(errorMessage);
  }

  return value;
}

// Asserts that a field is a string and returns the narrowed value.
function assertString(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new MessageValidationError(`${fieldName} must be a string`);
  }

  return value;
}

// Asserts that a field is a finite number and returns the narrowed value.
function assertNumber(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new MessageValidationError(`${fieldName} must be a number`);
  }

  return value;
}

// Enforces an exact key set with required and optional fields.
function assertExactKeys(
  objectValue: RecordValue,
  requiredKeys: string[],
  optionalKeys: string[] = []
): void {
  // Reject unknown keys to keep message formats strict.
  const allowed = new Set<string>([...requiredKeys, ...optionalKeys]);

  for (const key of Object.keys(objectValue)) {
    if (!allowed.has(key)) {
      throw new MessageValidationError(`Unexpected key '${key}'`);
    }
  }

  // Require every expected key to be explicitly present.
  for (const key of requiredKeys) {
    if (!Object.hasOwn(objectValue, key)) {
      throw new MessageValidationError(`Missing required key '${key}'`);
    }
  }
}

// Validates and normalizes a hello handshake message.
function validateHelloMessage(value: RecordValue): HelloMessage {
  assertExactKeys(value, ["type", "version"], ["agent"]);

  const version = assertString(value.version, "hello.version");
  if (!HELLO_VERSION_PATTERN.test(version)) {
    throw new MessageValidationError("hello.version must match 0.10.x");
  }

  const helloMessage: HelloMessage = {
    type: "hello",
    version
  };

  // Preserve agent only when present and valid.
  if (Object.hasOwn(value, "agent")) {
    helloMessage.agent = assertString(value.agent, "hello.agent");
  }

  return helloMessage;
}

// Validates a getpeers request message.
function validateGetPeersMessage(value: RecordValue): GetPeersMessage {
  assertExactKeys(value, ["type"]);

  return {
    type: "getpeers"
  };
}

// Validates peers payload shape and each peer address entry.
function validatePeersMessage(value: RecordValue): PeersMessage {
  assertExactKeys(value, ["type", "peers"]);

  if (!Array.isArray(value.peers)) {
    throw new MessageValidationError("peers.peers must be an array");
  }

  const peers: string[] = [];
  for (let index = 0; index < value.peers.length; index += 1) {
    // Validate element type and network address format per entry.
    const peer = assertString(value.peers[index], `peers.peers[${index}]`);
    if (peer.trim() === "") {
      throw new MessageValidationError(
        `peers.peers[${index}] is not a valid <host>:<port> entry`
      );
    }

    peers.push(peer);
  }

  return {
    type: "peers",
    peers
  };
}

// Validates an error message emitted by a remote peer.
function validateErrorMessage(value: RecordValue): ErrorMessage {
  assertExactKeys(value, ["type", "name", "description"]);

  return {
    type: "error",
    name: assertString(value.name, "error.name"),
    description: assertString(value.description, "error.description")
  };
}

function validateIhHaveObjectMessage(value: RecordValue): IHaveObjectMessage {
  assertExactKeys(value, ["type", "objectid"]);

  const objectid = assertString(value.objectid, "ihaveobject.objectid");
  if (objectid.trim() === "" || objectid.length !== 64 || !/^[a-f0-9]{64}$/.test(objectid)) {
    throw new MessageValidationError("ihaveobject.objectid must be a 64-character hexadecimal string");
  }

  return {
    type: "ihaveobject",
    objectid
  };
}

function validateGetObjectMessage(value: RecordValue): GetObjectMessage {
  assertExactKeys(value, ["type", "objectid"]);

  const objectid = assertString(value.objectid, "getobject.objectid");
  if (objectid.trim() === "" || objectid.length !== 64 || !/^[a-f0-9]{64}$/.test(objectid)) {
    throw new MessageValidationError("getobject.objectid must be a 64-character hexadecimal string");
  }

  return {
    type: "getobject",
    objectid
  };
}

function validateObjectMessage(value: RecordValue): ObjectMessage {
  assertExactKeys(value, ["type", "object"]);

  return {
    type: "object",
    object: validateApplicationObject(
      assertRecord(value.object, "object.object must be a JSON object")
    )
  };
}

function validateInput(value: RecordValue): Input {
  assertExactKeys(value, ["outPoint", "sig"]);

  return {
    outPoint: validateOutPoint(
      assertRecord(value.outPoint, "input.outPoint must be a JSON object")
    ),
    sig:
      value.sig === null
        ? null
        : assertString(value.sig, "input.sig")
  };
}

function validateOutPoint(value: RecordValue): OutPoint {
  assertExactKeys(value, ["txid", "index"]);

  return {
    txid: assertString(value.txid, "outPoint.txid"),
    index: assertNumber(value.index, "outPoint.index")
  };
}

function validateOutput(value: RecordValue): Output {
  assertExactKeys(value, ["pubkey", "value"]);

  return {
    pubkey: assertString(value.pubkey, "output.pubkey"),
    value: assertNumber(value.value, "output.value")
  };
}

function validateTransactionMessage(value: RecordValue): Transaction {
  assertExactKeys(value, ["type", "inputs", "outputs"]);
  if (value.type !== "transaction") {
    throw new MessageValidationError("transaction.type must be 'transaction'");
  }

  if (!Array.isArray(value.inputs)) {
    throw new MessageValidationError("transaction.inputs must be an array");
  }

  if (!Array.isArray(value.outputs)) {
    throw new MessageValidationError("transaction.outputs must be an array");
  }

  return {
    type: "transaction",
    inputs: value.inputs.map((input, index) =>
      validateInput(
        assertRecord(input, `transaction.inputs[${index}] must be a JSON object`)
      )
    ),
    outputs: value.outputs.map((output, index) =>
      validateOutput(
        assertRecord(output, `transaction.outputs[${index}] must be a JSON object`)
      )
    )
  };
}

function validateCoinbaseTransactionMessage(value: RecordValue): CoinbaseTransaction {
  assertExactKeys(value, ["type", "height", "outputs"]);
  if (value.type !== "transaction") {
    throw new MessageValidationError("coinbase.type must be 'transaction'");
  }

  if (!Array.isArray(value.outputs)) {
    throw new MessageValidationError("coinbase.outputs must be an array");
  }

  return {
    type: "transaction",
    height: assertNumber(value.height, "coinbase.height"),
    outputs: value.outputs.map((output, index) =>
      validateOutput(
        assertRecord(output, `coinbase.outputs[${index}] must be a JSON object`)
      )
    )
  };
}

function validateApplicationObject(value: RecordValue): ApplicationObject {
  const type = assertString(value.type, "object.object.type");
  if (type !== "transaction") {
    throw new MessageValidationError("object.object.type must be 'transaction'");
  }

  if (Object.hasOwn(value, "height")) {
    return validateCoinbaseTransactionMessage(value);
  }

  return validateTransactionMessage(value);
}

// Dispatches validation by message type and returns a typed protocol union.
export function validateMessage(value: unknown): AnyMessage {
  const record = assertRecord(value, "Message must be a JSON object");
  const type = assertString(record.type, "message.type");

  switch (type) {
    case "hello":
      return validateHelloMessage(record);
    case "getpeers":
      return validateGetPeersMessage(record);
    case "peers":
      return validatePeersMessage(record);
    case "ihaveobject":
      return validateIhHaveObjectMessage(record);
    case "getobject":
      return validateGetObjectMessage(record);
    case "error":
      return validateErrorMessage(record);
    case "object":
      return validateObjectMessage(record);
    default:
      throw new MessageValidationError("Unknown message type");
  }
}
