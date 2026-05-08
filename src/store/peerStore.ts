import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parsePeerAddress } from "../validation/peerAddress.js";
import { warn } from "../log.js";

const MAX_PEERS_PER_HOST = 1;

interface StoredPeerFile {
  peers: string[];
}

export interface PeerStoreOptions {
  filePath: string;
  bootstrapPeers: string[];
}

export class PeerStore {
  private readonly filePath: string;
  private readonly bootstrapPeers: string[];
  private readonly peers = new Set<string>();

  private loaded = false;
  private saveQueue: Promise<void> = Promise.resolve();

  // Stores file and bootstrap options used throughout the peer-store lifecycle.
  constructor(options: PeerStoreOptions) {
    this.filePath = options.filePath;
    this.bootstrapPeers = options.bootstrapPeers;
  }

  // Loads peers from disk, merges bootstrap peers, and persists normalized output.
  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

    await this.removeTempFiles();

    let shouldPersist = false;

    try {
      // Read and normalize existing peer data from disk.
      const content = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(content) as unknown;
      const loadedPeers = this.extractPeers(parsed);
      if (await this.addPeers(loadedPeers)) {
        shouldPersist = true;
      }
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      // Warn for malformed files but silently tolerate first-run missing files.
      if (nodeError.code !== "ENOENT") {
        warn(
          `[peer-store] Failed to parse peer file '${this.filePath}': ${nodeError.message}`
        );
      }
      shouldPersist = true;
    }

    // Always seed from bootstrap peers so the store starts with known network entrypoints.
    if (await this.addPeers(this.bootstrapPeers)) {
      shouldPersist = true;
    }

    // Persist once if normalization or seeding changed the set.
    if (shouldPersist) {
      await this.save();
    }

    this.loaded = true;
  }

  // Returns a stable sorted snapshot of known peers.
  getPeers(): string[] {
    return [...this.peers].sort();
  }

  // Merges new peers into the in-memory set and persists only on changes.
  async mergeAndPersist(peers: string[]): Promise<boolean> {
    const changed = await this.addPeers(peers);
    if (changed) {
      await this.save();
    }

    return changed;
  }

  // Adds valid peers while filtering invalid entries, duplicates, and flooded hosts.
  private async addPeers(peers: string[]): Promise<boolean> {
    let changed = false;
    const hostCounts = await this.getHostPeerCounts();

    for (const peer of peers) {
      let hostKey: string;

      try {
        // Parse once so validation and host-based rate limiting share the same result.
        const parsedPeer = await parsePeerAddress(peer);
        hostKey = parsedPeer.host.toLowerCase();
      } catch {
        continue;
      }

      // Only track peers once to keep the on-disk list canonical.
      if (this.peers.has(peer)) {
        continue;
      }

      if ((hostCounts.get(hostKey) ?? 0) >= MAX_PEERS_PER_HOST) {
        continue;
      }

      this.peers.add(peer);
      hostCounts.set(hostKey, (hostCounts.get(hostKey) ?? 0) + 1);
      changed = true;
    }

    return changed;
  }

  public async removePeer(peer: string): Promise<void> {
    this.peers.delete(peer);
    await this.save();
  }

  // Extracts peer arrays from either legacy array files or object-wrapped files.
  private extractPeers(value: unknown): string[] {
    if (Array.isArray(value)) {
      return value.filter((entry): entry is string => typeof entry === "string");
    }

    if (
      typeof value === "object" &&
      value !== null &&
      Array.isArray((value as StoredPeerFile).peers)
    ) {
      return (value as StoredPeerFile).peers.filter(
        (entry): entry is string => typeof entry === "string"
      );
    }

    // Unknown file shapes are treated as empty peer lists.
    return [];
  }

  private async getHostPeerCounts(): Promise<Map<string, number>> {
    const hostCounts = new Map<string, number>();

    for (const peer of this.peers) {
      try {
        const parsedPeer = await parsePeerAddress(peer);
        const hostKey = parsedPeer.host.toLowerCase();
        hostCounts.set(hostKey, (hostCounts.get(hostKey) ?? 0) + 1);
      } catch {
        // Ignore malformed legacy entries instead of failing future peer merges.
      }
    }

    return hostCounts;
  }

  // Serializes saves so concurrent callers don't race on the temp file.
  private async save(): Promise<void> {
    this.saveQueue = this.saveQueue.then(() => this.writeToDisk(), () => this.writeToDisk());
    return this.saveQueue;
  }

  private async writeToDisk(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });

    const payload = JSON.stringify({ peers: this.getPeers() }, null, 2) + "\n";
    const tempPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    try {
      await writeFile(tempPath, payload, "utf8");
      await rename(tempPath, this.filePath);
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }

  private async removeTempFiles(): Promise<void> {
    const directory = dirname(this.filePath);
    const prefix = `${basename(this.filePath)}.tmp-`;
    const entries = await readdir(directory).catch(() => []);

    for (const entry of entries) {
      if (!entry.startsWith(prefix)) {
        continue;
      }

      await unlink(join(directory, entry)).catch((error: NodeJS.ErrnoException) => {
        warn(`[peer-store] Failed to remove peer temp file '${entry}': ${error.message}`);
      });
    }
  }
}
