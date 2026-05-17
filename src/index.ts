import { loadConfig } from "./config.js";
import { MarabuNode } from "./node.js";
import { ObjectStore } from "./store/objectStore.js";
import { PeerStore } from "./store/peerStore.js";
import { log, error as logError } from "./log.js";

// Bootstraps configuration, networking, and lifecycle handlers for the node.
async function main(): Promise<void> {
  // Load runtime configuration once at startup.
  const config = loadConfig();

  // Create peer persistence seeded with the built-in bootstrap peers.
  const peerStore = new PeerStore({
    filePath: config.peersFile,
    bootstrapPeers: config.bootstrapPeers
  });
  const objectStore = new ObjectStore(config.objectStorePath);
  await objectStore.open();

  // Create and start the node before registering shutdown hooks.
  const node: MarabuNode = new MarabuNode(config, peerStore, objectStore);
  try {
    await node.start();
  } catch (error) {
    // Ensure the object store is cleaned up if startup fails before signal handlers are registered.
    await objectStore.close();
    throw error;
  }

  // Print key startup metadata for visibility and debugging.
  const listeningPort = node.getListeningPort();
  log(`[startup] Listening on ${config.host}:${listeningPort}`);
  log(`[startup] Peer store path: ${config.peersFile}`);
  log(`[startup] Object store path: ${config.objectStorePath}`);
  log(`[startup] Number of Mining Workers: ${config.numOfWorkers}`);


  // Guard against duplicate shutdown handling from repeated signals.
  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) {
      return;
    }

    stopping = true;
    log(`[shutdown] Received ${signal}. Stopping node...`);

    try {
      // Stop network activity and release resources cleanly.
      await node.stop();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError(`[shutdown] ${message}`);
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
  logError(`[fatal] ${message}`);
  process.exit(1);
});
