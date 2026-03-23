import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import LevelModule from "level-ts/dist/Level.js";
import type { ApplicationObject, UtxoSnapshot } from "../types.js";

const OBJECT_PREFIX = "object:";
const UTXO_PREFIX = "utxo:";

type StoredValue = ApplicationObject | UtxoSnapshot;

interface LevelDatabase {
  put(key: string, value: StoredValue): Promise<void>;
  get(key: string): Promise<StoredValue>;
  del(key: string): Promise<void>;
  close?(): Promise<void> | void;
}

const Level = (
  typeof LevelModule === "function" ? LevelModule : LevelModule.default
) as unknown as new (filePath: string) => LevelDatabase;

export class ObjectStore {
  private readonly filePath: string;
  private database: LevelDatabase | null = null;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  // Opens the backing Level database once during process startup.
  async open(): Promise<void> {
    if (this.database !== null) {
      return;
    }

    await mkdir(dirname(this.filePath), { recursive: true });
    this.database = new Level(this.filePath);
  }

  async put(key: string, object: ApplicationObject): Promise<void> {
    await this.putObject(key, object);
  }

  async putObject(objectId: string, object: ApplicationObject): Promise<void> {
    await this.putValue(this.objectKey(objectId), object);
  }

  async get(key: string): Promise<ApplicationObject> {
    return await this.getObject(key);
  }

  async getObject(objectId: string): Promise<ApplicationObject> {
    const value = await this.getValue(this.objectKey(objectId));
    if (!isApplicationObject(value)) {
      throw new Error(`Stored value for ${objectId} is not an application object`);
    }

    return value;
  }

  async has(key: string): Promise<boolean> {
    return await this.hasObject(key);
  }

  async hasObject(objectId: string): Promise<boolean> {
    return await this.hasValue(this.objectKey(objectId));
  }

  async delete(key: string): Promise<void> {
    await this.deleteObject(key);
  }

  async deleteObject(objectId: string): Promise<void> {
    await this.deleteValue(this.objectKey(objectId));
  }

  async putUtxo(blockId: string, snapshot: UtxoSnapshot): Promise<void> {
    await this.putValue(this.utxoKey(blockId), snapshot);
  }

  async getUtxo(blockId: string): Promise<UtxoSnapshot> {
    const value = await this.getValue(this.utxoKey(blockId));
    if (!isUtxoSnapshot(value)) {
      throw new Error(`Stored value for ${blockId} is not a UTXO snapshot`);
    }

    return value;
  }

  async hasUtxo(blockId: string): Promise<boolean> {
    return await this.hasValue(this.utxoKey(blockId));
  }

  async deleteUtxo(blockId: string): Promise<void> {
    await this.deleteValue(this.utxoKey(blockId));
  }

  async close(): Promise<void> {
    if (this.database === null) {
      return;
    }

    const database = this.database;
    this.database = null;

    if (typeof database.close === "function") {
      await database.close();
    }
  }

  private requireDatabase(): LevelDatabase {
    if (this.database === null) {
      throw new Error("Object store has not been opened");
    }

    return this.database;
  }

  private async putValue(key: string, value: StoredValue): Promise<void> {
    const database = this.requireDatabase();
    await database.put(key, value);
  }

  private async getValue(key: string): Promise<StoredValue> {
    const database = this.requireDatabase();
    return await database.get(key);
  }

  private async hasValue(key: string): Promise<boolean> {
    try {
      await this.getValue(key);
      return true;
    } catch {
      return false;
    }
  }

  private async deleteValue(key: string): Promise<void> {
    const database = this.requireDatabase();
    await database.del(key);
  }

  private objectKey(objectId: string): string {
    return `${OBJECT_PREFIX}${objectId}`;
  }

  private utxoKey(blockId: string): string {
    return `${UTXO_PREFIX}${blockId}`;
  }
}


export function isMissingObjectStoreError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    "notFound" in error && error.notFound === true
  ) || error.name === "NotFoundError";
}

function isApplicationObject(value: StoredValue): value is ApplicationObject {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (
      value.type === "transaction" ||
      value.type === "block"
    )
  );
}

function isUtxoSnapshot(value: StoredValue): value is UtxoSnapshot {
  return (
    typeof value === "object" &&
    value !== null &&
    "entries" in value &&
    Array.isArray(value.entries)
  );
}
