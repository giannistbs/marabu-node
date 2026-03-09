import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import LevelModule from "level-ts/dist/Level.js";
import type { ApplicationObject } from "./types.js";

interface LevelDatabase {
  put(key: string, value: ApplicationObject): Promise<void>;
  get(key: string): Promise<ApplicationObject>;
  del(key: string): Promise<void>;
  close?(): Promise<void> | void;
}

const Level = LevelModule.default as unknown as new (filePath: string) => LevelDatabase;

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
    const database = this.requireDatabase();
    await database.put(key, object);
  }

  async get(key: string): Promise<ApplicationObject> {
    const database = this.requireDatabase();
    return await database.get(key);
  }

  async delete(key: string): Promise<void> {
    const database = this.requireDatabase();
    await database.del(key);
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
}