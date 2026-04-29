import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import LevelModule from "level-ts/dist/Level.js";
import { ApplicationObject, UtxoSnapshot, GENESIS_BLOCK, BlockWithMetadata, ChainTip} from "../types.js";
import { computeObjectId } from "../protocol/hashing.js";

const OBJECT_PREFIX = "object:";
const UTXO_PREFIX = "utxo:";
const CHAIN_TIP_KEY = "chaintip";

type StoredValue = ApplicationObject | UtxoSnapshot | ChainTip;

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


  /*//////////////////////////////////////////////////////////////
                          OBJECT METHODS
  //////////////////////////////////////////////////////////////*/

  // Persists an application object under its prefixed object ID key.
  async putObject(objectId: string, object: ApplicationObject): Promise<void> {
    await this.putValue(this.objectKey(objectId), object);
  }

  // Retrieves and type-checks an application object by its object ID.
  async getObject(objectId: string): Promise<ApplicationObject> {
    const value = await this.getValue(this.objectKey(objectId));
    if (!isApplicationObject(value)) {
      throw new Error(`Stored value for ${objectId} is not an application object`);
    }

    return value;
  }

  // Returns true if an application object exists for the given object ID.
  async hasObject(objectId: string): Promise<boolean> {
    return await this.hasValue(this.objectKey(objectId));
  }

  // Removes the application object entry for the given object ID.
  async deleteObject(objectId: string): Promise<void> {
    await this.deleteValue(this.objectKey(objectId));
  }


  /*//////////////////////////////////////////////////////////////
                           UTXO METHODS
  //////////////////////////////////////////////////////////////*/

  // Persists a UTXO snapshot associated with the given block ID.
  async putUtxo(blockId: string, snapshot: UtxoSnapshot): Promise<void> {
    await this.putValue(this.utxoKey(blockId), snapshot);
  }

  // Retrieves and type-checks the UTXO snapshot for the given block ID.
  async getUtxo(blockId: string): Promise<UtxoSnapshot> {
    const value = await this.getValue(this.utxoKey(blockId));
    if (!isUtxoSnapshot(value)) {
      throw new Error(`Stored value for ${blockId} is not a UTXO snapshot`);
    }

    return value;
  }

  // Returns true if a UTXO snapshot exists for the given block ID.
  async hasUtxo(blockId: string): Promise<boolean> {
    return await this.hasValue(this.utxoKey(blockId));
  }

  // Removes the UTXO snapshot entry for the given block ID.
  async deleteUtxo(blockId: string): Promise<void> {
    await this.deleteValue(this.utxoKey(blockId));
  }


  /*//////////////////////////////////////////////////////////////
                           CHAINTIP METHODS
  //////////////////////////////////////////////////////////////*/

  // Persists a chain tip.
  async putChainTip(blockid: string): Promise<void> {
    await this.putValue(CHAIN_TIP_KEY, {
      type: "chaintip",
      blockid: blockid
    } as unknown as ChainTip);
  }

  // Retrieves and type-checks the chain tip.
  async getChainTip(): Promise<string> {
    const value = await this.getValue(CHAIN_TIP_KEY);
    if (!("type" in value && value.type === "chaintip" && "blockid" in value)) {
      throw new Error(`Stored value for chain tip is not a chain tip`);
    }
    return value.blockid;
  }


  /*//////////////////////////////////////////////////////////////
                          STORE LIFECYCLE
  //////////////////////////////////////////////////////////////*/

  // Opens the backing Level database once during process startup.
  async open(): Promise<void> {
    if (this.database !== null) {
      return;
    }

    await mkdir(dirname(this.filePath), { recursive: true });
    this.database = new Level(this.filePath);
    await this.seedGenesis();
  }

  // Nulls out the database reference and closes it if the driver supports it.
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

  // Seeds the database with the canonical genesis block and its empty post-state UTXO set.
  private async seedGenesis(): Promise<void> {
    const GENESIS_ID = computeObjectId(GENESIS_BLOCK);
    const hasGenesis = await this.hasObject(GENESIS_ID);
    if (!hasGenesis) {
      const genesisWithMetadata: BlockWithMetadata = {
        type: "blockwithmetadata",
        block: GENESIS_BLOCK,
        height: 0
      }
      await this.putObject(GENESIS_ID, genesisWithMetadata);
      await this.putUtxo(GENESIS_ID, { entries: [] });
    }
  }
  


  /*//////////////////////////////////////////////////////////////
                        PRIVATE HELPERS
  //////////////////////////////////////////////////////////////*/

  // Asserts the database is open and returns it; throws otherwise.
  private requireDatabase(): LevelDatabase {
    if (this.database === null) {
      throw new Error("Object store has not been opened");
    }

    return this.database;
  }

  // Writes any StoredValue under the given raw key.
  private async putValue(key: string, value: StoredValue): Promise<void> {
    const database = this.requireDatabase();
    await database.put(key, value);
  }

  // Reads any StoredValue by its raw key.
  private async getValue(key: string): Promise<StoredValue> {
    const database = this.requireDatabase();
    return await database.get(key);
  }

  // Returns true if the raw key exists, swallowing NotFoundError.
  private async hasValue(key: string): Promise<boolean> {
    try {
      await this.getValue(key);
      return true;
    } catch {
      return false;
    }
  }

  // Deletes the entry at the given raw key.
  private async deleteValue(key: string): Promise<void> {
    const database = this.requireDatabase();
    await database.del(key);
  }

  // Produces the namespaced LevelDB key for an application object.
  private objectKey(objectId: string): string {
    return `${OBJECT_PREFIX}${objectId}`;
  }

  // Produces the namespaced LevelDB key for a UTXO snapshot.
  private utxoKey(blockId: string): string {
    return `${UTXO_PREFIX}${blockId}`;
  }


  /*//////////////////////////////////////////////////////////////
                           CONSTRUCTOR
  //////////////////////////////////////////////////////////////*/

  constructor(filePath: string) {
    this.filePath = filePath;
  }
}


// Returns true for LevelDB "not found" errors across driver versions.
export function isMissingObjectStoreError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    "notFound" in error && error.notFound === true
  ) || error.name === "NotFoundError";
}

// Type guard: checks that a stored value is a transaction or block object.
function isApplicationObject(value: StoredValue): value is ApplicationObject {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (
      value.type === "transaction" ||
      value.type === "block" ||
      value.type === "blockwithmetadata"
    )
  );
}

// Type guard: checks that a stored value is a UTXO snapshot with an entries array.
function isUtxoSnapshot(value: StoredValue): value is UtxoSnapshot {
  return (
    typeof value === "object" &&
    value !== null &&
    "entries" in value &&
    Array.isArray(value.entries)
  );
}
