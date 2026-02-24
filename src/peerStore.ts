import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isValidPeerAddress } from "./validation.js";

interface StoredPeerFile {
  peers: string[];
}

export interface PeerStoreOptions {
  filePath: string;
  bootstrapPeers: string[];
  includeBootstrap: boolean;
}

export class PeerStore {
  private readonly filePath: string;
  private readonly bootstrapPeers: string[];
  private readonly includeBootstrap: boolean;
  private readonly peers = new Set<string>();

  private loaded = false;

  // Stores file and bootstrap options used throughout the peer-store lifecycle.
  constructor(options: PeerStoreOptions) {
    this.filePath = options.filePath;
    this.bootstrapPeers = options.bootstrapPeers;
    this.includeBootstrap = options.includeBootstrap;
  }

  // Loads peers from disk, merges bootstrap peers, and persists normalized output.
  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

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
        console.warn(
          `[peer-store] Failed to parse peer file '${this.filePath}': ${nodeError.message}`
        );
      }
      shouldPersist = true;
    }

    // Seed from bootstrap peers when enabled.
    if (this.includeBootstrap && await this.addPeers(this.bootstrapPeers)) {
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

  // Adds valid peers while filtering invalid entries and duplicates.
  private async addPeers(peers: string[]): Promise<boolean> {
    let changed = false;

    for (const peer of peers) {
      // Skip invalid addresses instead of poisoning the store.
      if (!await isValidPeerAddress(peer)) {
        continue;
      }

      // Only track peers once to keep the on-disk list canonical.
      if (!this.peers.has(peer)) {
        this.peers.add(peer);
        changed = true;
      }
    }

    return changed;
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

  // Persists peers atomically by writing a temp file and renaming into place.
  private async save(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });

    const payload = JSON.stringify({ peers: this.getPeers() }, null, 2) + "\n";
    const tempPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;

    await writeFile(tempPath, payload, "utf8");
    await rename(tempPath, this.filePath);
  }
}
