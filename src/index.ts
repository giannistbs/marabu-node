import { loadConfig, NodeConfig } from "./config.js";
import { MarabuNode } from "./node.js";
import { PeerStore } from "./peerStore.js";

// Bootstraps configuration, networking, and lifecycle handlers for the node.
async function main(): Promise<void> {
  // Load runtime configuration once at startup.
  const config: NodeConfig = loadConfig();

  // Create peer persistence with optional bootstrap population.
  const peerStore = new PeerStore({
    filePath: config.peersFile,
    bootstrapPeers: config.bootstrapPeers,
    includeBootstrap: !config.disableBootstrap
  });

  // Create and start the node before registering shutdown hooks.
  const node: MarabuNode = new MarabuNode(config, peerStore);
  await node.start();

  // Print key startup metadata for visibility and debugging.
  const listeningPort = node.getListeningPort();
  console.log(`[startup] Listening on ${config.host}:${listeningPort}`);
  console.log(`[startup] Peer store path: ${config.peersFile}`);

  // Guard against duplicate shutdown handling from repeated signals.
  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) {
      return;
    }

    stopping = true;
    console.log(`[shutdown] Received ${signal}. Stopping node...`);

    try {
      // Stop network activity and release resources cleanly.
      await node.stop();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[shutdown] ${message}`);
      process.exitCode = 1;
    }
  };

  // Forward interrupt and terminate signals into the shared shutdown path.
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

// Crash fast on unrecoverable startup errors.
main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[fatal] ${message}`);
  process.exit(1);
});
