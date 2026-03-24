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

export interface Block {
  T: string;
  created: number;
  miner?: string; // up to 128 characters
  nonce: string;
  note?: string; // up to 128 characters
  studentids?: string[]; // up to 10 ids
  previd: string | null;
  txids: string[];
  type: "block";
}

export const GENESIS_BLOCK = {
  T: "00000000abc00000000000000000000000000000000000000000000000000000",
  created: 1771159355,
  miner: "Marabu",
  nonce: "00dd82159556175752d9ba7349df67bddd237b59183747383f7b720e85c32347",
  note: "Financial Times 2026-02-13: Crypto's battle with the banks is splitting Trump's base",
  previd: null,
  txids: [],
  type: "block"
} as Block;

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
  outpoint: OutPoint;
  sig: string;
}

export interface Output {
  pubkey: string;
  value: number;
}

export interface UtxoEntry {
  outpoint: OutPoint;
  output: Output;
}

export interface UtxoSnapshot {
  entries: UtxoEntry[];
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

export type ApplicationObject = Transaction | CoinbaseTransaction | Block; 

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
  | ObjectMessage
  // | GetMemPool
  // | Mempool
  // | GetChainTip
  // | ChainTip;
