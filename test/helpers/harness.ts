import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MarabuNode } from "../../src/node.js";
import { PeerStore } from "../../src/peerStore.js";
import { ObjectStore } from "../../src/objectStore.js";
import type { NodeConfig } from "../../src/config.js";

export type ParsedMessage = Record<string, unknown> | { __raw: string };

export const HELLO = { type: "hello", version: "0.10.0" };

const DEFAULT_RESPONSE_WAIT_MS = 1000;

function parseLines(
  buffer: { value: string },
  chunk: string,
  out: ParsedMessage[]
): void {
  buffer.value += chunk;
  while (true) {
    const newlineIndex = buffer.value.indexOf("\n");
    if (newlineIndex < 0) {
      break;
    }
    let line = buffer.value.slice(0, newlineIndex);
    buffer.value = buffer.value.slice(newlineIndex + 1);
    if (line.endsWith("\r")) {
      line = line.slice(0, -1);
    }
    if (line.trim() === "") {
      continue;
    }
    try {
      out.push(JSON.parse(line) as ParsedMessage);
    } catch {
      out.push({ __raw: line });
    }
  }
}

export async function withTestNode<T>(
  fn: (context: { node: MarabuNode; host: string; port: number }) => Promise<T>
): Promise<T> {
  const tempDir = await mkdtemp(join(tmpdir(), "marabu-node-"));
  const config: NodeConfig = {
    host: "127.0.0.1",
    port: 0,
    version: "0.10.0",
    agent: "MarabuTest/0.10.0",
    peersFile: join(tempDir, "peers.json"),
    objectStorePath: join(tempDir, "object-store"),
    reconnectIntervalMs: 60_000,
    bootstrapPeers: []
  };

  const peerStore = new PeerStore({
    filePath: config.peersFile,
    bootstrapPeers: []
  });
  const objectStore = new ObjectStore(config.objectStorePath);
  await objectStore.open();

  const node = new MarabuNode(config, peerStore, objectStore);
  let started = false;
  try {
    await node.start();
    started = true;
  } catch (error) {
    await objectStore.close();
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }

  try {
    return await fn({
      node,
      host: config.host,
      port: node.getListeningPort()
    });
  } finally {
    if (started) {
      await node.stop();
    }
    // Allow residual LevelDB background I/O (compaction, WAL flush) to settle
    // before removing the temp directory. On CI, slower disk I/O can cause
    // these operations to outlive objectStore.close().
    await delay(50);
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function sendLines(options: {
  host: string;
  port: number;
  lines: string[];
  waitMs?: number;
}): Promise<ParsedMessage[]> {
  const waitMs = options.waitMs ?? DEFAULT_RESPONSE_WAIT_MS;
  const { host, port, lines } = options;

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const messages: ParsedMessage[] = [];
    const buffer = { value: "" };
    let settled = false;
    let endTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (endTimer !== null) {
        clearTimeout(endTimer);
        endTimer = null;
      }
      // Ensure no lingering async activity escapes the test boundary.
      if (!socket.destroyed) {
        socket.destroy();
      }
      resolve(messages);
    };

    socket.setTimeout(waitMs + 2000, () => {
      socket.destroy(new Error("socket timeout"));
    });

    socket.on("data", (chunk) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      parseLines(buffer, text, messages);
    });

    socket.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (endTimer !== null) {
        clearTimeout(endTimer);
        endTimer = null;
      }
      if (!socket.destroyed) {
        socket.destroy();
      }
      reject(error);
    });

    socket.on("close", () => {
      finish();
    });

    socket.on("connect", () => {
      for (const line of lines) {
        socket.write(`${line}\n`);
      }
      endTimer = setTimeout(() => socket.end(), waitMs);
    });
  });
}

export async function openPeer(options: {
  host: string;
  port: number;
  waitMs?: number;
}): Promise<{
  socket: net.Socket;
  messages: ParsedMessage[];
  waitFor: (
    predicate: (message: ParsedMessage) => boolean,
    timeoutMs?: number
  ) => Promise<ParsedMessage>;
}> {
  const waitMs = options.waitMs ?? DEFAULT_RESPONSE_WAIT_MS;
  const socket = net.createConnection({ host: options.host, port: options.port });
  const messages: ParsedMessage[] = [];
  const buffer = { value: "" };

  socket.on("data", (chunk) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    parseLines(buffer, text, messages);
  });

  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", (error) => reject(error));
  });

  socket.write(`${JSON.stringify(HELLO)}\n`);

  return {
    socket,
    messages,
    waitFor: async (predicate, timeoutMs = waitMs * 2) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = messages.find(predicate);
        if (found) {
          return found;
        }
        await delay(25);
      }
      throw new Error("timeout waiting for peer message");
    }
  };
}

export function findMessage(
  messages: ParsedMessage[],
  type: string
): Record<string, unknown> | undefined {
  return messages.find((message) => {
    return (
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      (message as Record<string, unknown>).type === type
    );
  }) as Record<string, unknown> | undefined;
}
