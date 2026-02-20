import type {
  AnyMessage,
  ErrorMessage,
  GetPeersMessage,
  HelloMessage,
  PeersMessage
} from "./types.js";

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
    if (!isValidPeerAddress(peer)) {
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
    case "error":
      return validateErrorMessage(record);
    default:
      throw new MessageValidationError("Unknown message type");
  }
}

// Parses and bounds-checks a port number from string form.
function parsePort(portText: string): number {
  const port = Number.parseInt(portText, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Invalid port");
  }

  return port;
}

export interface ParsedPeerAddress {
  host: string;
  port: number;
}

// Parses a peer string into structured host and port values.
export function parsePeerAddress(peer: string): ParsedPeerAddress {
  // Support bracketed IPv6 format: [host]:port.
  if (peer.startsWith("[")) {
    const ipv6Match = /^\[([^\]\s]+)\]:(\d{1,5})$/.exec(peer);
    if (!ipv6Match) {
      throw new Error("Invalid bracketed IPv6 peer address");
    }

    const host = ipv6Match[1];
    const portText = ipv6Match[2];
    if (host === undefined || portText === undefined) {
      throw new Error("Invalid bracketed IPv6 peer address");
    }

    return {
      host,
      port: parsePort(portText)
    };
  }

  // Support host:port for IPv4 addresses and hostnames.
  const hostMatch = /^([^:\s]+):(\d{1,5})$/.exec(peer);
  if (!hostMatch) {
    throw new Error("Invalid peer address");
  }

  const host = hostMatch[1];
  const portText = hostMatch[2];
  if (host === undefined || portText === undefined) {
    throw new Error("Invalid peer address");
  }

  return {
    host,
    port: parsePort(portText)
  };
}

// Checks whether a peer address parses successfully.
export function isValidPeerAddress(peer: string): boolean {
  try {
    parsePeerAddress(peer);
    return true;
  } catch {
    return false;
  }
}
