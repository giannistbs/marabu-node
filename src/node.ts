import net from "node:net";
import { encodeMessage, decodeLine } from "./codec.js";
import type { NodeConfig } from "./config.js";
import { ObjectStore } from "./objectStore.js";
import { PeerStore } from "./peerStore.js";
import type { AnyMessage, ErrorMessage } from "./types.js";
import { MessageValidationError, parsePeerAddress, isValidPeerAddress } from "./validation.js";

interface ConnectionState {
  id: number;
  buffer: string;
  helloReceived: boolean;
  outbound: boolean;
  peerLabel: string;
}

export class MarabuNode {
  private readonly server: net.Server;
  private readonly connections = new Map<net.Socket, ConnectionState>();
  private readonly outboundSocketsByPeer = new Map<string, net.Socket>();
  private readonly dialingPeers = new Set<string>();
  private readonly failedAttemptsByPeer = new Map<string, number>();
  private readonly maxFailedAttempts = 5;

  private reconnectTimer: NodeJS.Timeout | null = null;
  private nextConnectionId = 1;
  private running = false;

  // Initializes socket server listeners and shared runtime state.
  constructor(
    private readonly config: NodeConfig,
    private readonly peerStore: PeerStore,
    private readonly objectStore: ObjectStore
  ) {
    this.server = net.createServer();
    // Track inbound sockets and route them through common connection handling.
    this.server.on("connection", (socket) => {
      const remote = `${socket.remoteAddress ?? "unknown"}:${socket.remotePort ?? 0}`;
      console.log(`[inbound ${remote}] OK: connected`);
      this.handleConnectedSocket(socket, false);
    });
    // Surface server-level failures for observability.
    this.server.on("error", (error) => {
      console.error(`[server] ${error.message}`);
    });
  }

  // Starts peer discovery, begins listening, and schedules reconnect attempts.
  async start(): Promise<void> {

    // Leave early if the node is already running.
    if (this.running) {
      return;
    }

    // Load persisted peers before opening outbound connections.
    await this.peerStore.load();

    // Start the TCP server and fail startup if bind/listen errors occur.
    await new Promise<void>((resolve, reject) => {
      const onListening = (): void => {
        this.server.off("error", onError);
        resolve();
      };

      const onError = (error: Error): void => {
        this.server.off("listening", onListening); // @q: why listen onerror?
        reject(error);
      };

      this.server.once("listening", onListening);
      this.server.once("error", onError);
      this.server.listen(this.config.port, this.config.host);
    });

    this.running = true;
    // Attempt immediate outbound dials instead of waiting for the first interval tick.
    this.tryConnectDiscoveredPeers();

    // Keep retrying known peers at a fixed interval.
    this.reconnectTimer = setInterval(() => {
      this.tryConnectDiscoveredPeers();
    }, this.config.reconnectIntervalMs);
  }

  // Stops reconnect loops, tears down sockets, and closes the listening server.
  async stop(): Promise<void> {
    if (!this.running) {
      await this.objectStore.close();
      return;
    }

    this.running = false;

    if (this.reconnectTimer !== null) {
      clearInterval(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Destroy all active sockets so in-flight handlers terminate promptly.
    for (const socket of this.connections.keys()) {
      socket.destroy();
    }
    this.connections.clear();
    this.outboundSocketsByPeer.clear();
    this.dialingPeers.clear();

    if (this.server.listening) {
      // Wait for server close completion to ensure clean shutdown.
      await new Promise<void>((resolve) => {
        this.server.close(() => resolve());
      });
    }

    await this.objectStore.close();
  }

  // Returns the effective bound port after startup (useful when binding to 0).
  getListeningPort(): number {
    const address = this.server.address();
    if (address !== null && typeof address === "object") {
      return address.port;
    }

    return this.config.port;
  }

  // Registers a new socket, wires event handlers, and kicks off handshake messages.
  private handleConnectedSocket(
    socket: net.Socket,
    outbound: boolean,
    outboundPeer: string | null = null
  ): void {
    // Create per-connection parsing and handshake state.
    const state: ConnectionState = {
      id: this.nextConnectionId,
      buffer: "",
      helloReceived: false,
      outbound,
      peerLabel: outboundPeer ?? this.describeSocket(socket)
    };

    this.nextConnectionId += 1;
    this.connections.set(socket, state);

    // Keep outbound-peer lookup in sync for dedupe and reconnect behavior.
    if (outboundPeer !== null) {
      this.outboundSocketsByPeer.set(outboundPeer, socket);
    }

    socket.setNoDelay(true);
    socket.setKeepAlive(true);

    // Accumulate stream data and parse line-delimited messages.
    socket.on("data", (chunk) => {
      const textChunk = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      this.handleData(socket, textChunk);
    });

    socket.on("error", (error) => {
      console.warn(`[connection ${state.id}] ${error.message}`);
    });

    socket.on("close", () => {
      this.connections.delete(socket);
      if (outboundPeer !== null) {
        // Remove mapping only if it still points to this closed socket.
        const mappedSocket = this.outboundSocketsByPeer.get(outboundPeer);
        if (mappedSocket === socket) {
          this.outboundSocketsByPeer.delete(outboundPeer);
        }
        this.dialingPeers.delete(outboundPeer);
      }
    });

    // Begin protocol handshake immediately after connection setup.
    this.sendMessage(socket, {
      type: "hello",
      version: this.config.version,
      agent: this.config.agent
    });
    this.sendMessage(socket, {
      type: "getpeers"
    });
  }

  // Buffers stream chunks into complete protocol lines and dispatches messages.
  private handleData(socket: net.Socket, chunk: string): void {
    const state = this.connections.get(socket);
    if (state === undefined || socket.destroyed) {
      return;
    }

    state.buffer += chunk;

    while (true) {
      // Wait for a full newline-delimited frame before attempting decode.
      const newlineIndex = state.buffer.indexOf("\n");
      if (newlineIndex < 0) {
        break;
      }

      let line = state.buffer.slice(0, newlineIndex);
      state.buffer = state.buffer.slice(newlineIndex + 1);

      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }

      if (line.trim() === "") {
        continue;
      }

      let message: AnyMessage;
      try {
        // Parse and validate message shape before protocol dispatch.
        message = decodeLine(line);
      } catch (error) {
        const description =
          error instanceof MessageValidationError
            ? error.message
            : "Unable to parse incoming message";

        this.sendErrorAndClose(socket, {
          type: "error",
          name: "INVALID_FORMAT",
          description
        });
        return;
      }

      // Dispatch a validated message
      const keepConnection = this.handleValidatedMessage(socket, state, message);
      // Stops the processing loop if the handler closed the socket or the message was invalid.
      if (!keepConnection) {
        return;
      }
    }
  }

  // Enforces handshake order and routes validated messages to protocol handlers.
  private handleValidatedMessage(
    socket: net.Socket,
    state: ConnectionState,
    message: AnyMessage
  ): boolean {
    // Require hello as the first successfully parsed message.
    if (!state.helloReceived) {
      if (message.type !== "hello") {
        this.sendErrorAndClose(socket, {
          type: "error",
          name: "INVALID_HANDSHAKE",
          description: "Expected hello as first valid message"
        });
        return false;
      }

      state.helloReceived = true;
      return true;
    }

    switch (message.type) {
      case "hello":
        // Ignore duplicate hellos after handshake completion.
        return true;
      case "getpeers": {
        // Reply with the current peer snapshot on demand.
        this.sendMessage(socket, {
          type: "peers",
          peers: this.peerStore.getPeers()
        });
        return true;
      }
      case "peers": {
        // Merge newly discovered peers asynchronously.
        void this.handlePeers(message.peers);
        return true;
      }
      case "error": {
        // Remote errors are logged but do not force local disconnect.
        console.warn(
          `[connection ${state.id}] remote error ${message.name}: ${message.description}`
        );
        return true;
      }
      default: {
        // Reject unexpected validated variants defensively.
        this.sendErrorAndClose(socket, {
          type: "error",
          name: "INVALID_FORMAT",
          description: "Unsupported message type"
        });
        return false;
      }
    }
  }

  // Stores newly learned peers and attempts connections when the set expands.
  private async handlePeers(peers: string[]): Promise<void> {
    const changed = await this.peerStore.mergeAndPersist(peers);
    if (changed) {
      this.tryConnectDiscoveredPeers();
    }
  }

  // Encodes and writes a protocol message unless the socket is already closed.
  private sendMessage(socket: net.Socket, message: AnyMessage): void {
    if (socket.destroyed || socket.writableEnded) {
      return;
    }

    try {
      socket.write(encodeMessage(message));
    } catch {
      // Hard-close broken sockets to avoid partial protocol state.
      socket.destroy();
    }
  }

  // Sends an error payload and closes the socket in a single operation.
  private sendErrorAndClose(socket: net.Socket, errorMessage: ErrorMessage): void {
    if (socket.destroyed || socket.writableEnded) {
      return;
    }

    try {
      socket.end(encodeMessage(errorMessage));
    } catch {
      // Fall back to destroy when graceful close cannot be written.
      socket.destroy();
    }
  }

  // Attempts outbound connections for all known peers not already connected.
  private tryConnectDiscoveredPeers(): void {
    if (!this.running) {
      return;
    }

    const peers: string[] = this.peerStore.getPeers();
    for (const peer of peers) {
      // Skip peers already connected or currently in dial progress.
      if (this.outboundSocketsByPeer.has(peer) || this.dialingPeers.has(peer)) {
        continue;
      }

      this.connectToPeer(peer);
    }
  }

  // Dials a peer and wires timeout/error/connect handlers for lifecycle tracking.
  private async connectToPeer(peer: string): Promise<void> {

    let parsed: {
      host: string;
      port: number 
    };

    try {
      if (!await isValidPeerAddress(peer)) {
        console.warn(`[outbound ${peer}] FAIL: invalid address`);
        return;
      }

      parsed = await parsePeerAddress(peer);
    } catch (err) {
      console.warn(`[outbound ${peer}] FAIL: failed to parse address: ${(err as Error).message}`);
      return;
    }

    this.dialingPeers.add(peer);

    const socket = net.createConnection({ host: parsed.host, port: parsed.port });
    socket.setNoDelay(true);
    socket.setTimeout(8_000);

    const onTimeout = (): void => {
      // Release dial bookkeeping so future reconnect attempts are allowed.
      this.dialingPeers.delete(peer);
      socket.off("error", onError);
      socket.off("connect", onConnect);
      socket.destroy();
      console.warn(`[outbound ${peer}] FAIL: connection timed out`);
      this.recordFailedAttempt(peer);
    };

    const onError = (error: Error): void => {
      // Reset listeners and state on failed outbound attempts.
      this.dialingPeers.delete(peer);
      socket.off("timeout", onTimeout);
      socket.off("connect", onConnect);
      socket.destroy();
      console.warn(`[outbound ${peer}] FAIL: ${error.message}`);
      this.recordFailedAttempt(peer);
    };

    const onConnect = (): void => {
      // Transition from dialing state to a fully tracked connection.
      this.dialingPeers.delete(peer);
      socket.off("error", onError);
      socket.off("timeout", onTimeout);
      socket.setTimeout(0);
      console.log(`[outbound ${peer}] OK: connected`);
      this.handleConnectedSocket(socket, true, peer);
      this.failedAttemptsByPeer.delete(peer);
    };

    socket.once("timeout", onTimeout);
    socket.once("error", onError);
    socket.once("connect", onConnect);
  }

  private recordFailedAttempt(peer: string): void {
    const attempts = (this.failedAttemptsByPeer.get(peer) ?? 0) + 1;
    this.failedAttemptsByPeer.set(peer, attempts);
    if (attempts >= this.maxFailedAttempts) {
      console.warn(`[outbound ${peer}] removing after ${attempts} failed attempts`);
      this.peerStore.removePeer(peer).catch((err: unknown) => {
        console.error(`[outbound ${peer}] failed to remove peer: ${err}`);
      });
      this.failedAttemptsByPeer.delete(peer);
    }
  }

  // Formats a socket's remote endpoint for logs and state labels.
  private describeSocket(socket: net.Socket): string {
    const host = socket.remoteAddress ?? "unknown-host";
    const port = socket.remotePort ?? 0;
    return `${host}:${port}`;
  }
}
