import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ObjectStore } from "../src/store/objectStore.js";
import type { ApplicationObject, UtxoSnapshot } from "../src/types.js";

test("ObjectStore round-trips application objects with the object API", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "marabu-object-store-"));
  const storePath = join(tempDir, "db");
  const store = new ObjectStore(storePath);
  const object: ApplicationObject = {
    type: "transaction",
    height: 0,
    outputs: [{ pubkey: "11".repeat(32), value: 50 }]
  };

  await store.open();

  try {
    await store.putObject("coinbase", object);

    const loaded = await store.getObject("coinbase");

    assert.deepEqual(loaded, object);
    assert.equal(await store.hasObject("coinbase"), true);
  } finally {
    await store.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ObjectStore stores UTXO snapshots separately from application objects", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "marabu-object-store-"));
  const storePath = join(tempDir, "db");
  const store = new ObjectStore(storePath);
  const objectId = "shared-id";
  const object: ApplicationObject = {
    type: "transaction",
    height: 1,
    outputs: [{ pubkey: "22".repeat(32), value: 75 }]
  };
  const snapshot: UtxoSnapshot = {
    entries: [
      {
        outpoint: { txid: objectId, index: 0 },
        output: { pubkey: "22".repeat(32), value: 75 }
      }
    ]
  };

  await store.open();

  try {
    await store.putObject(objectId, object);
    await store.putUtxo(objectId, snapshot);

    assert.deepEqual(await store.getObject(objectId), object);
    assert.deepEqual(await store.getUtxo(objectId), snapshot);
    assert.equal(await store.hasObject(objectId), true);
    assert.equal(await store.hasUtxo(objectId), true);
  } finally {
    await store.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});
