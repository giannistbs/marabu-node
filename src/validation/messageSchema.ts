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
  OutPoint,
  Block
} from "../types.js";
import {
  ValidationError,
  isNonNegativeInteger,
  isValidEd25519PublicKey,
  type RecordValue,
  assertRecord,
  assertString,
  assertNonNegativeInteger,
  assertExactKeys
} from "./utils.js";

const HELLO_VERSION_PATTERN = /^0\.10\.\d+$/;
const OBJECT_ID_PATTERN = /^[a-f0-9]{64}$/;
const ED25519_SIGNATURE_PATTERN = /^[a-f0-9]{128}$/;


// Dispatches stateless wire validation by message type and returns a typed protocol union.
export function validateWireMessage(value: unknown): AnyMessage {
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

// Validates an "ihaveobject" message, ensuring the objectid field is present and well-formed.
function validateIhHaveObjectMessage(value: RecordValue): IHaveObjectMessage {
  assertExactKeys(value, ["type", "objectid"]);

  const objectid = assertObjectId(value.objectid, "ihaveobject.objectid");

  return {
    type: "ihaveobject",
    objectid
  };
}

// Validates a "getobject" request message.
function validateGetObjectMessage(value: RecordValue): GetObjectMessage {
  assertExactKeys(value, ["type", "objectid"]);

  const objectid = assertObjectId(value.objectid, "getobject.objectid");

  return {
    type: "getobject",
    objectid
  };
}

// Validates a full "object" message with a nested application object.
function validateObjectMessage(value: RecordValue): ObjectMessage {
  assertExactKeys(value, ["type", "object"]);

  return {
    type: "object",
    object: validateApplicationObjectShape(
      assertRecord(value.object, "object.object must be a JSON object")
    )
  };
}

// Validates the stateless shape of an application object.
function validateApplicationObjectShape(value: RecordValue): ApplicationObject {
  const type = assertString(value.type, "object.object.type");

  if (Object.hasOwn(value, "height") && type === 'transaction') {
    return validateCoinbaseTransactionMessage(value);
  } else if (type === 'transaction') {
    return validateTransactionMessage(value);
  } else if (type === 'block') {
    return validateBlockMessage(value);
  } else {
    throw new MessageValidationError(
      "object.object.type must be 'transaction' or 'block'"
    );
  }
}

// Validates a coinbase transaction (height present, only outputs, no inputs).
function validateCoinbaseTransactionMessage(value: RecordValue): CoinbaseTransaction {
  assertExactKeys(value, ["type", "height", "outputs"]);
  if (value.type !== "transaction") {
    throw new MessageValidationError("coinbase.type must be 'transaction'");
  }

  // Outputs must be an array of output objects.
  if (!Array.isArray(value.outputs)) {
    throw new MessageValidationError("coinbase.outputs must be an array");
  }

  return {
    type: "transaction",
    height: assertNonNegativeInteger(value.height, "coinbase.height"),
    outputs: value.outputs.map((output, index) =>
      validateOutput(
        assertRecord(output, `coinbase.outputs[${index}] must be a JSON object`)
      )
    )
  };
}

// Validates a standard transaction (must include both inputs and outputs).
function validateTransactionMessage(value: RecordValue): Transaction {
  assertExactKeys(value, ["type", "inputs", "outputs"]);
  if (value.type !== "transaction") {
    throw new MessageValidationError(
      "transaction.type must be 'transaction'"
    );
  }

  // Both inputs and outputs must be arrays.
  if (!Array.isArray(value.inputs)) {
    throw new MessageValidationError("transaction.inputs must be an array");
  }

  if (!Array.isArray(value.outputs)) {
    throw new MessageValidationError("transaction.outputs must be an array");
  }
  if (value.inputs.length === 0) {
    throw new MessageValidationError(
      "transaction.inputs must contain at least one input"
    );
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

// Validates a standard transaction (must include both inputs and outputs).
function validateBlockMessage(value: RecordValue): Block {
  assertExactKeys(value, ["type", "T", "created", "nonce", "previd", "txids"], ["miner", "note", "studentids"]);
  if (value.type !== "block") {
    throw new MessageValidationError(
      "block.type must be 'block'"
    );
  }

  if (!Array.isArray(value.txids)) {
    throw new MessageValidationError("block.txids must be an array");
  }

  const T = assertString(value.T, "block.T");
  if (T !== "00000000abc00000000000000000000000000000000000000000000000000000") {
    throw new MessageValidationError("block.T is incorrect");
  }

  const created = assertNonNegativeInteger(value.created, "block.created");
  const nonce = assertString(value.nonce, "block.nonce");
  const previd = assertString(value.previd, "block.previd");
  const txids = value.txids.map((txid, index) =>
    assertObjectId(txid, `block.txids[${index}]`)
  );

  const block: Block = {
    type: "block",
    T,
    created,
    nonce,
    previd,
    txids
  };

  // Check and add optional human-readable miner identifier, capped at 128 characters.
  if (typeof value.miner !== "undefined") {
    const miner = assertString(value.miner, "block.miner");
    if (miner.length > 128) {
      throw new MessageValidationError("block.miner must have a maximum of 128 characters");
    }
    block.miner = miner;
  }

  // Check and add optional note attached to the block, capped at 128 characters.
  if (typeof value.note !== "undefined") {
    const note = assertString(value.note, "block.note");
    if (note.length > 128) {
      throw new MessageValidationError("block.note must have a maximum of 128 characters");
    }
    block.note = note;
  }

  // Check and add optional list of student IDs associated with this block, capped at 10 entries.
  if (typeof value.studentids !== "undefined") {
    if (!Array.isArray(value.studentids) || value.studentids.length > 10) {
      throw new MessageValidationError("block.studentids must have a maximum of 10 elements");
    }
    block.studentids = value.studentids.map((id, index) =>
      assertString(id, `block.studentids[${index}]`)
    );
  }

  return block;
}

// Validates a single transaction input (references an outpoint and signature).
function validateInput(value: RecordValue): Input {
  assertExactKeys(value, ["outpoint", "sig"]);

  return {
    outpoint: validateOutpoint(
      assertRecord(value.outpoint, "input.outpoint must be a JSON object")
    ),
    sig: assertSignature(value.sig, "input.sig")
  };
}

// Validates an outpoint reference (txid/index pair).
function validateOutpoint(value: RecordValue): OutPoint {
  assertExactKeys(value, ["txid", "index"]);

  return {
    txid: assertObjectId(value.txid, "outpoint.txid"),
    index: assertNonNegativeInteger(value.index, "outpoint.index")
  };
}

// Validates a single transaction output (pubkey and value).
function validateOutput(value: RecordValue): Output {
  assertExactKeys(value, ["pubkey", "value"]);

  return {
    pubkey: assertPublicKey(value.pubkey, "output.pubkey"),
    value: assertNonNegativeInteger(value.value, "output.value")
  };
}


    /*//////////////////////////////////////////////////////////////
                            SPECIFIC HELPERS
    //////////////////////////////////////////////////////////////*/


// Asserts that a field is a 64-character lowercase hexadecimal object id.
function assertObjectId(value: unknown, fieldName: string): string {
  const objectId = assertString(value, fieldName);
  if (!OBJECT_ID_PATTERN.test(objectId)) {
    throw new MessageValidationError(
      `${fieldName} must be a 64-character hexadecimal string`
    );
  }

  return objectId;
}

// Asserts that a field is a hex-encoded Ed25519 signature.
function assertSignature(value: unknown, fieldName: string): string {
  return assertHexString(
    value,
    fieldName,
    ED25519_SIGNATURE_PATTERN,
    "a 64-byte lowercase hexadecimal Ed25519 signature"
  );
}

// Asserts that a field is a lowercase hexadecimal string matching a given pattern.
function assertHexString(
  value: unknown,
  fieldName: string,
  pattern: RegExp,
  description: string
): string {
  const hexString = assertString(value, fieldName);
  if (!pattern.test(hexString)) {
    throw new MessageValidationError(`${fieldName} must be ${description}`);
  }

  return hexString;
}

// Asserts that a field is a hex-encoded Ed25519 public key.
function assertPublicKey(value: unknown, fieldName: string): string {
  const pubkey = assertString(value, fieldName);
  if (!isValidEd25519PublicKey(pubkey)) {
    throw new MessageValidationError(
      `${fieldName} must be a 32-byte lowercase hexadecimal Ed25519 public key`
    );
  }

  return pubkey;
}

    /*//////////////////////////////////////////////////////////////
                                 ERROR TYPES
    //////////////////////////////////////////////////////////////*/

export class MessageValidationError extends ValidationError {
  constructor(message: string) {
    super(message);
    this.name = "MessageValidationError";
  }
}