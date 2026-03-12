import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ObjectStore } from "../src/objectStore.js";
import type { ApplicationObject } from "../src/types.js";

test("ObjectStore round-trips application objects via level-ts", async () => {
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
    await store.put("coinbase", object);

    const loaded = await store.get("coinbase");

    assert.deepEqual(loaded, object);
    assert.equal(await store.has("coinbase"), true);
  } finally {
    await store.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});
