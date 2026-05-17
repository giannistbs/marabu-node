import path from "node:path";

export const DEFAULT_BOOTSTRAP_PEERS = [
  "95.179.158.137:18018",
  "95.179.132.22:18018",
  "45.32.235.245:18018"
] as const;

const DEFAULT_PORT = 18018;
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_VERSION = "0.10.0";
const DEFAULT_AGENT = "Siesto/0.10.0";
const DEFAULT_RECONNECT_INTERVAL_MS = 30_000;
const DEFAULT_NUM_OF_WORKERS = 1;
const DEFAULT_MINER_NAME = "Siesto";

export interface NodeConfig {
  host: string;
  port: number;
  version: string;
  agent: string;
  peersFile: string;
  objectStorePath: string;
  reconnectIntervalMs: number;
  bootstrapPeers: string[];
  numOfWorkers: number;
  miner: string;
}

// Loads node configuration from environment variables and project defaults.
export function loadConfig(env: NodeJS.ProcessEnv = process.env): NodeConfig {
  return {
    host: env.MARABU_HOST ?? DEFAULT_HOST,
    port: Number(env.MARABU_PORT ?? DEFAULT_PORT),
    version: DEFAULT_VERSION,
    agent: DEFAULT_AGENT,
    peersFile: env.MARABU_PEERS_FILE ?? path.resolve(process.cwd(), "data", "peers.json"),
    objectStorePath:
      env.MARABU_OBJECT_STORE_PATH ?? path.resolve(process.cwd(), "data", "object-store"),
    reconnectIntervalMs: Number(
      env.MARABU_RECONNECT_INTERVAL_MS ?? DEFAULT_RECONNECT_INTERVAL_MS
    ),
    bootstrapPeers: [...DEFAULT_BOOTSTRAP_PEERS],
    numOfWorkers: Number(env.NUM_OF_WORKERS ?? DEFAULT_NUM_OF_WORKERS),
    miner: env.MINER_NAME ?? DEFAULT_MINER_NAME
  };
}
