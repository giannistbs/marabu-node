import type {
  AnyMessage,
  ErrorMessage,
  GetPeersMessage,
  HelloMessage,
  PeersMessage
} from "./types.js";
import dns from "node:dns/promises";

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

// Regular expressions for validating IP addresses and hostnames.
const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

// Regular expression for validating hostnames.
const HOSTNAME_PATTERN = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

// Set of blocked IP addresses.
const BLOCKED_IPS = new Set(["1.1.1.1", "8.8.8.8", "8.8.4.4", "9.9.9.9", "76.76.21.21", "213.149.188.242"]);

// Placeholder and documentation hostnames that are never real peers.
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "example.com",
  "example1.com",
  "example2.com",
  "example3.com",
  "example4.com",
  "example5.com",
  "myexample.com"
]);

// Checks if a host is a valid IPv4 address.
function isValidIPv4(host: string): boolean {
  const match = IPV4_PATTERN.exec(host);
  if (!match) return false;
  for (const octet of match.slice(1)) {
    if (Number(octet) > 255) return false;
  }
  return true;
}

// Returns true when the IPv4 address falls in a reserved, private, or test-net range.
function isReservedIPv4(host: string): boolean {
  const [a = 0, b = 0, c = 0] = host.split(".").map(Number);
  return (
    a === 0 ||                              // 0.0.0.0/8
    a === 10 ||                             // 10.0.0.0/8
    a === 127 ||                            // 127.0.0.0/8
    (a === 100 && b >= 64 && b <= 127) ||   // 100.64.0.0/10
    (a === 169 && b === 254) ||             // 169.254.0.0/16
    (a === 172 && b >= 16 && b <= 31) ||    // 172.16.0.0/12
    (a === 192 && b === 0 && c === 2) ||    // 192.0.2.0/24
    (a === 192 && b === 168) ||             // 192.168.0.0/16
    (a === 198 && b === 51 && c === 100) || // 198.51.100.0/24
    (a === 203 && b === 0 && c === 113) ||  // 203.0.113.0/24
    a >= 224                                // 224.0.0.0+
  );
}

// Parses and bounds-checks a port number from string form.
function parsePort(portText: string): number {
  const port = Number.parseInt(portText, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Invalid port");
  }

  return port;
}

// Structured peer address object with host and port.
export interface ParsedPeerAddress {
  host: string;
  port: number;
}

// Parses a peer string into structured host and port values.
export async function parsePeerAddress(peer: string): Promise<ParsedPeerAddress> {
  // Support bracketed IPv6 format: [host]:port.
  if (peer.startsWith("[")) {
    const ipv6Match = /^\[([^\]\s]+)\]:(\d{1,5})$/.exec(peer);
    if (!ipv6Match) {
      throw new Error("Invalid bracketed IPv6 peer address");
    }

    const host = ipv6Match[1];
    const portText = ipv6Match[2];
    if (host === undefined || portText === undefined || host === "::1") {
      throw new Error("Invalid bracketed IPv6 peer address");
    }

    if (!await validateResolvableHost(host)) {
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

  const host = hostMatch[1] ?? "";
  const portText = hostMatch[2] ?? "";

  if (isValidIPv4(host)) {
    if (isReservedIPv4(host) || BLOCKED_IPS.has(host)) {
      throw new Error("Invalid peer address");
    }
  } else if (HOSTNAME_PATTERN.test(host) && host.length <= 253) {
    if (BLOCKED_HOSTNAMES.has(host.toLowerCase())) {
      throw new Error("Invalid peer address");
    }
    if (!await validateResolvableHost(host)) {
      throw new Error("Invalid peer address");
    }
  } else {
    throw new Error("Invalid peer address");
  }

  return {
    host,
    port: parsePort(portText)
  };
}

// Resolves hostnames and validates IP literals through the platform resolver.
async function validateResolvableHost(host: string): Promise<boolean> {
  try {
    await dns.lookup(host);
    return true;
  } catch {
    return false;
  }
}

// Checks whether a peer address parses successfully.
export async function isValidPeerAddress(peer: string): Promise<boolean> {
  return await parsePeerAddress(peer).then(() => true).catch(() => false);
}
