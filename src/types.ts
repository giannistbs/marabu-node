// Canonical protocol error names supported by this minimal node.
export const ERROR_NAMES = [
  "INTERNAL_ERROR",
  "INVALID_FORMAT",
  "UNKNOWN_OBJECT",
  "UNFINDABLE_OBJECT",
  "INVALID_HANDSHAKE",
  "INVALID_TX_OUTPOINT",
  "INVALID_TX_SIGNATURE",
  "INVALID_TX_CONSERVATION",
  "INVALID_BLOCK_COINBASE",
  "INVALID_BLOCK_TIMESTAMP",
  "INVALID_BLOCK_POW",
  "INVALID_GENESIS"
] as const;

export type ErrorName = (typeof ERROR_NAMES)[number];

export interface HelloMessage {
  type: "hello";
  version: string;
  agent?: string;
}

export interface GetPeersMessage {
  type: "getpeers";
}

export interface PeersMessage {
  type: "peers";
  peers: string[];
}

export interface ErrorMessage {
  type: "error";
  name: string;
  description: string;
}

// Union of all message envelopes exchanged on the wire.
export type AnyMessage =
  | HelloMessage
  | GetPeersMessage
  | PeersMessage
  | ErrorMessage;
