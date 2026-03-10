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

export interface GetObjectMessage {
  type: "getobject";
  objectid: string;
}

export interface IHaveObjectMessage {
  type: "ihaveobject";
  objectid: string;
}

// export interface GetMemPool {
//   type: "getmempool";
// }

// export interface Mempool {
//   type: "mempool";
//   txids: string[];
// }

// export interface GetChainTip {
//   type: "getchaintip";
// }

// export interface ChainTip {
//   type: "chaintip";
//   blockid: string;
// }

export interface ErrorMessage {
  type: "error";
  name: string;
  description: string;
}

export interface OutPoint {
  txid: string;
  index: number;
}

export interface Input {
  outPoint: OutPoint;
  sig: string | null;
}

export interface Output {
  pubkey: string;
  value: number;
}

export interface Transaction {
  type: "transaction";
  inputs: Input[];
  outputs: Output[];
}

export interface CoinbaseTransaction {
  type: "transaction";
  height: number;
  outputs: Output[];
}

export type ApplicationObject = Transaction | CoinbaseTransaction; // for now.. 

export interface ObjectMessage {
  type: "object";
  object: ApplicationObject;
}

// Union of all message envelopes exchanged on the wire.
export type AnyMessage =
  | HelloMessage
  | GetPeersMessage
  | PeersMessage
  | ErrorMessage
  | GetObjectMessage
  | IHaveObjectMessage
  // | GetMemPool
  // | Mempool
  // | GetChainTip
  // | ChainTip
  | ApplicationObject;
