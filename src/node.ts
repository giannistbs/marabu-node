import net from "node:net";
import { encodeMessage, decodeLine } from "./protocol/codec.js";
import type { NodeConfig } from "./config.js";
import { computeObjectId } from "./protocol/hashing.js";
import { isMissingObjectStoreError, ObjectStore } from "./store/objectStore.js";
import { Mempool as TransactionMempool } from "./store/mempool.js";
import { PeerStore } from "./store/peerStore.js";
import {
  type ApplicationObject,
  type AnyMessage,
  type BlockWithMetadata,
  type ErrorMessage,
  type GetObjectMessage,
  type IHaveObjectMessage,
  type GetMemPool,
  type Mempool as MempoolMessage,
  type ObjectMessage,
  type Transaction,
  type UtxoSnapshot,
  type GetChainTipMessage,
  type ChainTip
} from "./types.js";
import {
  ApplicationObjectValidationError,
  MissingParentBlockError,
  validateApplicationObjectState
} from "./validation/objectState.js";
import { MessageValidationError } from "./validation/messageSchema.js";
import { parsePeerAddress, isValidPeerAddress } from "./validation/peerAddress.js";
import { log, warn, error as logError } from "./log.js";

interface ConnectionState {
  id: number;
  buffer: string;
  helloReceived: boolean;
  outbound: boolean;
  peerLabel: string;
  inFlightHandlers: Set<Promise<void>>;
}

interface ObjectWaiter {
  resolve: (object: ApplicationObject) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout | null;
}

// Compares two chain tips and returns txids removed from the old fork and added on the new fork.
async function collectForkDiff(
  oldTipId: string,
  newTipId: string,
  store: ObjectStore
): Promise<{ orphaned: string[]; confirmed: string[] }> {
  // Loads one block object and rejects corrupted or mistyped store entries.
  const getBlock = async (blockId: string): Promise<BlockWithMetadata> => {
    const object = await store.getObject(blockId);
    if (object.type !== "blockwithmetadata") {
      throw new Error(`Object ${blockId} is not a block`);
    }
    return object;
  };

  let oldCursor = await getBlock(oldTipId);
  let newCursor = await getBlock(newTipId);
  const oldBlocks: BlockWithMetadata[] = [];
  const newBlocks: BlockWithMetadata[] = [];

  // First move the taller chain back until both cursors are at the same height.
  while (oldCursor.height > newCursor.height) {
    oldBlocks.push(oldCursor);
    oldCursor = await getBlock(oldCursor.block.previd!);
  }

  while (newCursor.height > oldCursor.height) {
    newBlocks.push(newCursor);
    newCursor = await getBlock(newCursor.block.previd!);
  }

  // Then walk both chains together; collected old blocks are orphaned, new blocks are confirmed.
  while (computeObjectId(oldCursor) !== computeObjectId(newCursor)) {
    oldBlocks.push(oldCursor);
    newBlocks.push(newCursor);
    oldCursor = await getBlock(oldCursor.block.previd!);
    newCursor = await getBlock(newCursor.block.previd!);
  }

  return {
    orphaned: oldBlocks.flatMap((block) => block.block.txids),
    confirmed: newBlocks.flatMap((block) => block.block.txids)
  };
}

export class MarabuNode {
  private readonly server: net.Server;
  private readonly connections = new Map<net.Socket, ConnectionState>();
  private readonly pendingObjectWaiters = new Map<string, Set<ObjectWaiter>>();
  private readonly inFlightObjectValidations = new Map<string, Promise<ApplicationObject>>();
  private readonly outboundSocketsByPeer = new Map<string, net.Socket>();
  private readonly dialingPeers = new Set<string>();
  private readonly failedAttemptsByPeer = new Map<string, number>();
  private readonly mempool = new TransactionMempool();
  private readonly maxFailedAttempts = 3;

  private reconnectTimer: NodeJS.Timeout | null = null;
  private nextConnectionId = 1;
  private running = false;


  /*//////////////////////////////////////////////////////////////
                            HANDLER FUNCTIONS
  //////////////////////////////////////////////////////////////*/

  // Enforces handshake order and routes validated messages to protocol handlers.
  private async handleValidatedMessage(
    socket: net.Socket,
    state: ConnectionState,
    message: AnyMessage
  ): Promise<boolean> {
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
        // Merge newly discovered peers asynchronously without risking unhandled rejections.
        void this.handlePeers(message.peers).catch((error: unknown) => {
          const description = error instanceof Error ? error.message : String(error);
          logError(`[peers] failed to persist discovered peers: ${description}`);
        });
        return true;
      }
      case "error": {
        // Remote errors are logged but do not force local disconnect.
        warn(
          `[connection ${state.id}] remote error ${message.name}: ${message.description}`
        );
        return true;
      }
      case "object":
        return await this.handleObjectMessage(socket, message);
      case "ihaveobject":
        await this.handleIHaveObjectMessage(socket, message);
        return true;
      case "getobject":
        return await this.handleGetObjectMessage(socket, message);
      case "getchaintip":
        return await this.handleGetChaintipMessage(socket, message);
      case "chaintip":
        return await this.handleChaintipMessage(socket, message);
      case "getmempool":
        this.handleGetMempoolMessage(socket, message);
        return true;
      case "mempool":
        await this.handleMempoolMessage(message);
        return true;
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

  // Handles a getobject message from a peer.
  private async handleGetObjectMessage(socket: net.Socket, message: GetObjectMessage): Promise<boolean> {
    const objectId = message.objectid;
    try {
      let object = await this.objectStore.getObject(objectId);
      if (object.type === "blockwithmetadata") {
        object = object.block;
      }
      this.sendMessage(socket, {
        type: "object",
        object
      });
    } catch (error: unknown) {
      if (isMissingObjectStoreError(error)) {
        return true;
      }
      throw error;
    }

    return true;
  }

  // Handles an object message from a peer.
  private async handleObjectMessage(
    socket: net.Socket,
    message: ObjectMessage
  ): Promise<boolean> {
    const incomingObjectId = computeObjectId(message.object);

    try {
      if (await this.objectStore.hasObject(incomingObjectId)) {
        return true;
      }

      const inFlightValidation = this.inFlightObjectValidations.get(incomingObjectId);
      if (inFlightValidation !== undefined) {
        await inFlightValidation;
        return true;
      }

      this.markObjectArrived(incomingObjectId);

      const validation = this.validateAndStoreObject(incomingObjectId, message.object)
        .catch((error: unknown) => {
          const failure = error instanceof Error ? error : new Error(String(error));
          this.rejectObjectWaiters(
            incomingObjectId,
            this.createObjectDependencyError(incomingObjectId, failure)
          );
          throw failure;
        })
        .finally(() => {
          this.inFlightObjectValidations.delete(incomingObjectId);
        });

      this.inFlightObjectValidations.set(incomingObjectId, validation);
      await validation;
      return true;
    } catch (error) {
      if (error instanceof MissingParentBlockError) {
        // Parent metadata without its UTXO snapshot is treated as unavailable chain state.
        this.sendErrorAndClose(socket, {
          type: "error",
          name: "UNFINDABLE_OBJECT",
          description: error.message
        });
        return false;
      }

      if (error instanceof ApplicationObjectValidationError) {
        this.sendErrorAndClose(socket, {
          type: "error",
          name: error.errorName,
          description: error.message
        });
        return false;
      }

      throw error;
    }
  }

  // Validates incoming objects, stores accepted ones, and applies chain/mempool side effects.
  private async validateAndStoreObject(
    objectId: string,
    object: ApplicationObject
  ): Promise<ApplicationObject> {
    const objectToSave = await validateApplicationObjectState(object, {
      getObject: (key: string) => this.objectStore.getObject(key),
      getUtxo: (blockId: string) => this.objectStore.getUtxo(blockId),
      // Standalone transactions validate against confirmed UTXOs plus accepted mempool outputs.
      getMempoolUtxo: () => this.mempool.getUtxoMap(),
      putUtxo: (blockId: string, snapshot: UtxoSnapshot) => this.objectStore.putUtxo(blockId, snapshot),
      requestObject: (requestedObjectId: string) => this.sendGetObjectToAllPeers(requestedObjectId),
      waitForObject: (requestedObjectId: string, timeoutMs: number) => this.waitForObject(requestedObjectId, timeoutMs)
    });

    if (await this.objectStore.hasObject(objectId)) {
      const storedObject = await this.objectStore.getObject(objectId);
      this.resolveObjectWaiters(objectId, storedObject);
      return storedObject;
    }

    await this.objectStore.putObject(objectId, objectToSave);
    if (objectToSave.type === "transaction" && !("height" in objectToSave)) {
      // Validation has already spent inputs against the mempool view, so it is safe to apply now.
      this.mempool.addTransaction(objectId, objectToSave);
    }

    if (objectToSave.type === "blockwithmetadata") {
      // Keep the previous tip so a real tip change can remove confirmed txs and restore reorg orphans.
      const previousTipId = await this.objectStore.getChainTip();
      const tipChanged = await this.updateChainTip({ type: "chaintip", blockid: objectId });
      if (tipChanged) {
        await this.rebuildMempoolAfterBlock(objectToSave, previousTipId);
      }
    }

    this.resolveObjectWaiters(objectId, objectToSave);
    this.sendIHaveObjectToAllPeers(objectId);
    return objectToSave;
  }

  // Handles an ihaveobject message from a peer.
  private async handleIHaveObjectMessage(
    socket: net.Socket,
    message: IHaveObjectMessage
  ): Promise<void> {
    const objectId = message.objectid;
    if (await this.objectStore.hasObject(objectId)) {
      return;
    }

    this.sendGetObjectToPeer(socket, objectId);
  }

  // Stores newly learned peers and attempts connections when the set expands.
  private async handlePeers(peers: string[]): Promise<void> {
    const changed = await this.peerStore.mergeAndPersist(peers);
    if (changed) {
      this.tryConnectDiscoveredPeers();
    }
  }

  // Sends an ihaveobject message to all connected peers
  private sendIHaveObjectToAllPeers(objectId: string): void {
    for (const socket of this.connections.keys()) {
      this.sendMessage(socket, {
        type: "ihaveobject",
        objectid: objectId
      });
    }
  }

  // Sends getobject message to all connected peers
  private sendGetObjectToAllPeers(objectId: string): void {
    for (const socket of this.connections.keys()) {
      this.sendGetObjectToPeer(socket, objectId);
    }
  }

  // Updates the stored chain tip if the candidate block is strictly better.
  private async updateChainTip(chaintip: ChainTip): Promise<boolean> {
    // Fetch the candidate block - must be a valid blockwithmetadata object.
    const newTipObject = await this.objectStore.getObject(chaintip.blockid);
    if (newTipObject.type !== "blockwithmetadata") {
      throw new Error(`Chain tip candidate ${chaintip.blockid} is not a block`);
    }

    let currentTipBlockId: string;
    try {
      // Try to retrieve the current chain tip's block id from the object store.
      currentTipBlockId = await this.objectStore.getChainTip();
    } catch (error: unknown) {
      // If there is no chain tip stored yet accept the candidate as the new tip.
      if (isMissingObjectStoreError(error)) {
        await this.objectStore.putChainTip(chaintip.blockid);
        return true;
      }
      // Other errors should propagate.
      throw error;
    }

    // Fetch the current tip block object for comparison.
    const currentTipObject = await this.objectStore.getObject(currentTipBlockId);
    if (currentTipObject.type !== "blockwithmetadata") {
      // Corrupted store: chain tip does not refer to a block.
      throw new Error(`Stored chain tip ${currentTipBlockId} is not a block`);
    }

    // If the candidate's height is higher, update the tip.
    if (newTipObject.height > currentTipObject.height) {
      await this.objectStore.putChainTip(chaintip.blockid);
      return true;
    }

    // Otherwise, keep the current tip.
    return false;
  }


  // Rebuilds the in-memory mempool after a new active-chain block is accepted.
  private async rebuildMempoolAfterBlock(
    newBlock: BlockWithMetadata,
    previousTipId: string
  ): Promise<void> {
    const newBlockId = computeObjectId(newBlock);

    const confirmedTxids = new Set(newBlock.block.txids);
    const orphanedTxids: string[] = [];

    if (newBlock.block.previd !== previousTipId) {
      // Reorg case: old-chain txs may become mempool candidates again.
      const forkDiff = await collectForkDiff(previousTipId, newBlockId, this.objectStore);
      for (const txid of forkDiff.confirmed) {
        confirmedTxids.add(txid);
      }
      orphanedTxids.push(...forkDiff.orphaned);
    }

    const survivingTxids = this.mempool
      .getTxids()
      .filter((txid) => !confirmedTxids.has(txid));
    const candidateTxids = [
      ...survivingTxids,
      ...orphanedTxids.filter((txid) => !confirmedTxids.has(txid))
    ];
    const candidates: { txid: string; transaction: Transaction }[] = [];

    // Reload candidates from storage so rebuild only replays transaction objects we still have.
    for (const txid of candidateTxids) {
      try {
        const object = await this.objectStore.getObject(txid);
        if (object.type === "transaction" && !("height" in object)) {
          candidates.push({ txid, transaction: object });
        }
      } catch (error: unknown) {
        if (!isMissingObjectStoreError(error)) {
          throw error;
        }
      }
    }

    const newUtxo = await this.objectStore.getUtxo(newBlockId);
    // Reset to confirmed chain state, then replay surviving/orphaned transactions that still fit.
    this.mempool.rebuild(newUtxo, candidates);
  }


  // Handles a getmempool message from a peer.
  private handleGetMempoolMessage(socket: net.Socket, _message: GetMemPool): void {
    this.sendMessage(socket, {
      type: "mempool",
      txids: this.mempool.getTxids()
    });
  }

  // Requests mempool transactions that this node has not seen yet.
  private async handleMempoolMessage(message: MempoolMessage): Promise<void> {
    for (const txid of message.txids) {
      if (!await this.objectStore.hasObject(txid)) {
        this.sendGetObjectToAllPeers(txid);
      }
    }
  }


  // Handles a chaintip message from a peer.
  private async handleChaintipMessage(
    socket: net.Socket,
    message: ChainTip
  ): Promise<boolean> {
    const blockid = message.blockid;
    if (await this.objectStore.hasObject(blockid)) {
      return true;
    }

    this.sendGetObjectToAllPeers(blockid);
    
    return true;
  }

  // Handles a getchaintip message from a peer.
  private async handleGetChaintipMessage(
    socket: net.Socket,
    message: GetChainTipMessage
  ): Promise<boolean> {
    try {
      const chainTip = await this.objectStore.getChainTip();
      this.sendMessage(socket, {
        type: "chaintip",
        blockid: chainTip
      });
      return true;
    } catch (error: unknown) {
      if (isMissingObjectStoreError(error)) {
        return true;
      }
      throw error;
    }
  }

  // Sends getChaintip message to all connected peers
  private sendGetChaintipToAllPeers(): void {
    for (const socket of this.connections.keys()) {
      this.sendMessage(socket, {
        type: "getchaintip"
      });
    }
  }

  // Sends a getmempool request to all connected peers.
  private sendGetMempoolToAllPeers(): void {
    for (const socket of this.connections.keys()) {
      this.sendMessage(socket, {
        type: "getmempool"
      });
    }
  }

  // Sends a getobject request to a connected peer.
  private sendGetObjectToPeer(socket: net.Socket, objectId: string): void {
    this.sendMessage(socket, {
      type: "getobject",
      objectid: objectId
    });
  }

  // Waits for a missing object to be stored while the event loop keeps processing messages.
  private async waitForObject(
    objectId: string,
    timeoutMs: number
  ): Promise<ApplicationObject> {
    try {
      return await this.objectStore.getObject(objectId);
    } catch (error: unknown) {
      if (!isMissingObjectStoreError(error)) {
        throw error;
      }
    }

    return await new Promise<ApplicationObject>((resolve, reject) => {
      const waiters = this.pendingObjectWaiters.get(objectId) ?? new Set<ObjectWaiter>();

      const removeWaiter = (): void => {
        waiters.delete(waiter);
        if (waiters.size === 0) {
          this.pendingObjectWaiters.delete(objectId);
        }
      };

      const timeout = setTimeout(() => {
        removeWaiter();
        const error = new Error(`Timed out waiting for object ${objectId}`);
        error.name = "ObjectWaitTimeoutError";
        reject(error);
      }, timeoutMs);

      const waiter: ObjectWaiter = {
        timeout,
        resolve: (object) => {
          if (waiter.timeout !== null) {
            clearTimeout(waiter.timeout);
            waiter.timeout = null;
          }
          removeWaiter();
          resolve(object);
        },
        reject: (error) => {
          if (waiter.timeout !== null) {
            clearTimeout(waiter.timeout);
            waiter.timeout = null;
          }
          removeWaiter();
          reject(error);
        }
      };

      waiters.add(waiter);
      this.pendingObjectWaiters.set(objectId, waiters);

      if (this.inFlightObjectValidations.has(objectId)) {
        this.markObjectArrived(objectId);
      }

      // Re-check after registering the waiter so we do not miss a just-arrived object.
      void this.objectStore
        .getObject(objectId)
        .then((object) => {
          this.resolveObjectWaiters(objectId, object);
        })
        .catch((error: unknown) => {
          if (isMissingObjectStoreError(error)) {
            return;
          }

          const failure = error instanceof Error ? error : new Error(String(error));
          this.rejectObjectWaiters(objectId, failure);
        });
    });
  }

  // Clears arrival timers after the exact requested object is being validated.
  private markObjectArrived(objectId: string): void {
    const waiters = this.pendingObjectWaiters.get(objectId);
    if (waiters === undefined) {
      return;
    }

    for (const waiter of waiters) {
      if (waiter.timeout !== null) {
        clearTimeout(waiter.timeout);
        waiter.timeout = null;
      }
    }
  }

  // Resolves all waiters that were blocked on the given object ID.
  private resolveObjectWaiters(objectId: string, object: ApplicationObject): void {
    const waiters = this.pendingObjectWaiters.get(objectId);
    if (waiters === undefined) {
      return;
    }

    this.pendingObjectWaiters.delete(objectId);
    for (const waiter of waiters) {
      waiter.resolve(object);
    }
  }

  // Rejects all waiters for a single object ID.
  private rejectObjectWaiters(objectId: string, error: Error): void {
    const waiters = this.pendingObjectWaiters.get(objectId);
    if (waiters === undefined) {
      return;
    }

    this.pendingObjectWaiters.delete(objectId);
    for (const waiter of waiters) {
      waiter.reject(error);
    }
  }

  // Wraps a validation failure so dependent block waits can map it to UNFINDABLE_OBJECT.
  private createObjectDependencyError(objectId: string, cause: Error): Error {
    const error = new Error(`Object ${objectId} failed validation while resolving a dependency`);
    error.name = "ObjectDependencyValidationError";
    error.cause = cause;
    return error;
  }

  // Rejects every outstanding object wait when the node is shutting down.
  private rejectAllPendingObjectWaiters(error: Error): void {
    for (const objectId of this.pendingObjectWaiters.keys()) {
      this.rejectObjectWaiters(objectId, error);
    }
  }





  /*//////////////////////////////////////////////////////////////
                            NODE METHODS
  //////////////////////////////////////////////////////////////*/

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

    const tipId = await this.objectStore.getChainTip();
    const tipUtxo = await this.objectStore.getUtxo(tipId);
    // The mempool is intentionally in-memory, so rebuild its base view on every boot.
    this.mempool.initialize(tipUtxo);

    this.running = true;
    // Attempt immediate outbound dials instead of waiting for the first interval tick.
    this.tryConnectDiscoveredPeers();

    // Keep retrying known peers at a fixed interval.
    this.reconnectTimer = setInterval(() => {
      this.tryConnectDiscoveredPeers();
    }, this.config.reconnectIntervalMs);


    // Wait briefly to allow outbound peer connections, then ask for chain and mempool state.
    setTimeout(() => {
      this.sendGetChaintipToAllPeers();
      this.sendGetMempoolToAllPeers();
    }, 500); // 500ms delay; adjust as needed based on network conditions
    
  }

  // Stops reconnect loops, tears down sockets, and closes the listening server.
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.running = false;

    if (this.reconnectTimer !== null) {
      clearInterval(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Collect pending processing promises before destroying sockets so we can
    // wait for in-flight handlers to settle before closing the object store.
    const pendingProcessing = Array.from(this.connections.values()).flatMap(
      (state) => Array.from(state.inFlightHandlers)
    );

    // Destroy all active sockets so in-flight handlers terminate promptly.
    for (const socket of this.connections.keys()) {
      socket.destroy();
    }
    this.connections.clear();
    this.outboundSocketsByPeer.clear();
    this.dialingPeers.clear();
    this.rejectAllPendingObjectWaiters(new Error("Node is stopping"));

    // Wait for any in-flight message handlers to finish before closing the
    // object store; this prevents LevelDB errors on CI where disk I/O is slow.
    await Promise.allSettled(pendingProcessing);

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
      peerLabel: outboundPeer ?? this.describeSocket(socket),
      inFlightHandlers: new Set()
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
      try {
        this.handleData(socket, textChunk);
      } catch (error: unknown) {
        this.handleConnectionFailure(socket, state, error);
      }
    });

    socket.on("error", (error) => {
      warn(`[connection ${state.id}] ${error.message}`);
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

        logError(description)

        this.sendErrorAndClose(socket, {
          type: "error",
          name: "INVALID_FORMAT",
          description
        });
        return;
      }

      // Start the handler and let awaited work resume later without blocking this socket.
      const handler = this.handleValidatedMessage(socket, state, message)
        .then((keepConnection) => {
          if (!keepConnection) {
            return;
          }
        })
        .catch((error: unknown) => {
          this.handleConnectionFailure(socket, state, error);
        })
        .finally(() => {
          state.inFlightHandlers.delete(handler);
        });

      state.inFlightHandlers.add(handler);
    }
  }

  // Reports an unexpected handler failure to the peer and records it in local logs.
  private handleConnectionFailure(
    socket: net.Socket,
    state: ConnectionState,
    error: unknown
  ): void {
    const description =
      error instanceof Error ? error.message : "Unexpected connection error";
    try {
      this.sendErrorAndClose(socket, {
        type: "error",
        name: "INTERNAL_ERROR",
        description
      });
    } catch (closeError) {
      logError(
        `[connection ${state.id}] close failed: ${
          closeError instanceof Error ? closeError.message : String(closeError)
        }`
      );
    }

    logError(
      `[connection ${state.id}] handleData failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
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
  // Formats a socket's remote endpoint for logs and state labels.
  private describeSocket(socket: net.Socket): string {
    const host = socket.remoteAddress ?? "unknown-host";
    const port = socket.remotePort ?? 0;
    return `${host}:${port}`;
  }
  // Dials a peer and wires timeout/error/connect handlers for lifecycle tracking.
  private async connectToPeer(peer: string): Promise<void> {

    let parsed: {
      host: string;
      port: number 
    };

    try {
      if (!await isValidPeerAddress(peer)) {
        warn(`[outbound ${peer}] FAIL: invalid address`);
        return;
      }

      parsed = await parsePeerAddress(peer);
    } catch (err) {
      warn(`[outbound ${peer}] FAIL: failed to parse address: ${(err as Error).message}`);
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
      warn(`[outbound ${peer}] FAIL: connection timed out`);
      this.recordFailedAttempt(peer);
    };

    const onError = (error: Error): void => {
      // Reset listeners and state on failed outbound attempts.
      this.dialingPeers.delete(peer);
      socket.off("timeout", onTimeout);
      socket.off("connect", onConnect);
      socket.destroy();
      warn(`[outbound ${peer}] FAIL: ${error.message}`);
      this.recordFailedAttempt(peer);
    };

    const onConnect = (): void => {
      // Transition from dialing state to a fully tracked connection.
      this.dialingPeers.delete(peer);
      socket.off("error", onError);
      socket.off("timeout", onTimeout);
      socket.setTimeout(0);
      log(`[outbound ${peer}] OK: connected`);
      this.handleConnectedSocket(socket, true, peer);
      this.failedAttemptsByPeer.delete(peer);
    };

    socket.once("timeout", onTimeout);
    socket.once("error", onError);
    socket.once("connect", onConnect);
  }

  // Records a failed outbound attempt and removes the peer if too many attempts have failed.
  private recordFailedAttempt(peer: string): void {
    const attempts = (this.failedAttemptsByPeer.get(peer) ?? 0) + 1;
    this.failedAttemptsByPeer.set(peer, attempts);
    if (attempts >= this.maxFailedAttempts) {
      warn(`[outbound ${peer}] removing after ${attempts} failed attempts`);
      this.peerStore.removePeer(peer).catch((err: unknown) => {
        logError(`[outbound ${peer}] failed to remove peer: ${err}`);
      });
      this.failedAttemptsByPeer.delete(peer);
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



  /*//////////////////////////////////////////////////////////////
                            CONSTRUCTOR
  //////////////////////////////////////////////////////////////*/

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
      log(`[inbound ${remote}] OK: connected`);
      this.handleConnectedSocket(socket, false);
    });
    // Surface server-level failures for observability.
    this.server.on("error", (error) => {
      logError(`[server] ${error.message}`);
    });
  }

}
