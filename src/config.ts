import path from "node:path";

export const DEFAULT_BOOTSTRAP_PEERS = [
  "95.179.158.137:18018",
  "95.179.132.22:18018",
  "45.32.235.245:18018"
] as const;

const DEFAULT_PORT = 18018;
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_VERSION = "0.10.0";
const DEFAULT_AGENT = "Marabu-Minimal-TS/0.10.0";
const DEFAULT_RECONNECT_INTERVAL_MS = 30_000;

export interface NodeConfig {
  host: string;
  port: number;
  version: string;
  agent: string;
  peersFile: string;
  disableBootstrap: boolean;
  reconnectIntervalMs: number;
  bootstrapPeers: string[];
}

// Parses flexible boolean-like environment variable values.
function parseBoolean(value: string | undefined): boolean {
  // Treat missing values as disabled for feature-style environment flags.
  if (value === undefined) {
    return false;
  }

  // Accept a small set of common truthy textual values.
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

// Parses a non-negative integer environment variable with fallback support.
function parsePositiveInt(
  value: string | undefined,
  defaultValue: number,
  fieldName: string
): number {
  // Fall back to defaults when variables are omitted or empty.
  if (value === undefined || value.trim() === "") {
    return defaultValue;
  }

  // Parse explicitly in base-10 to avoid surprising coercion rules.
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${fieldName} must be a non-negative integer`);
  }

  return parsed;
}

// Loads node configuration from environment variables and project defaults.
export function loadConfig(env: NodeJS.ProcessEnv = process.env): NodeConfig {
  // Resolve the listening port and validate it against TCP limits.
  const port = parsePositiveInt(env.MARABU_PORT, DEFAULT_PORT, "MARABU_PORT");
  if (port > 65_535) {
    throw new Error("MARABU_PORT must be <= 65535");
  }

  // Resolve reconnect cadence used by the outbound dial loop.
  const reconnectIntervalMs = parsePositiveInt(
    env.MARABU_RECONNECT_INTERVAL_MS,
    DEFAULT_RECONNECT_INTERVAL_MS,
    "MARABU_RECONNECT_INTERVAL_MS"
  );

  // Default to the repository-local peer file when not explicitly set.
  const peersFile =
    env.MARABU_PEERS_FILE ?? path.resolve(process.cwd(), "data", "peers.json");

  // Build the final runtime config with environment overrides applied.
  return {
    host: env.MARABU_HOST ?? DEFAULT_HOST,
    port,
    version: env.MARABU_VERSION ?? DEFAULT_VERSION,
    agent: env.MARABU_AGENT ?? DEFAULT_AGENT,
    peersFile,
    disableBootstrap: parseBoolean(env.MARABU_DISABLE_BOOTSTRAP),
    reconnectIntervalMs,
    bootstrapPeers: [...DEFAULT_BOOTSTRAP_PEERS]
  };
}
