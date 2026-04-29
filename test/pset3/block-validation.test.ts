import assert from "node:assert/strict";
import { test } from "node:test";
import { computeObjectId } from "../../src/protocol/hashing.js";
import type {
  ApplicationObject,
  Block,
  BlockWithMetadata,
  ErrorName,
  Transaction,
  UtxoSnapshot
} from "../../src/types.js";
import { GENESIS_BLOCK } from "../../src/types.js";
import {
  ApplicationObjectValidationError,
  validateApplicationObjectState
} from "../../src/validation/objectState.js";
import {
  HELLO,
  findMessage,
  openPeer,
  sendLines,
  type ParsedMessage as HarnessParsedMessage,
  withTestNode
} from "../helpers/harness.js";

const GENESIS_BLOCK_ID = computeObjectId(GENESIS_BLOCK);
const REQUIRED_TARGET =
  "00000000abc00000000000000000000000000000000000000000000000000000";

const ASSIGNMENT_TX: ApplicationObject = {
  height: 1,
  outputs: [
    {
      pubkey: "b6a95d7b410ae1eb924898ae584d21523b53aa5a78d1bc54abe964fd8e63f487",
      value: 50_000_000_000_000
    }
  ],
  type: "transaction"
};

const ASSIGNMENT_TX_ID = computeObjectId(ASSIGNMENT_TX);

const ASSIGNMENT_BLOCK: Block = {
  T: REQUIRED_TARGET,
  created: 1_772_028_037,
  miner: "kalaburi",
  nonce: "b067391b9caf9821861e83cfc4d4656150ff2f1f800dbf37bdc76d211e76bf86",
  previd: GENESIS_BLOCK_ID,
  txids: [ASSIGNMENT_TX_ID],
  type: "block"
};

const ASSIGNMENT_BLOCK_ID = computeObjectId(ASSIGNMENT_BLOCK);

// Checks that a response set contains no protocol error.
function assertNoError(
  messages: HarnessParsedMessage[],
  context: string
): void {
  const error = findMessage(messages, "error") as { name?: unknown } | undefined;
  assert.ok(!error, `unexpected error during ${context}`);
}

// Checks that a response set contains the expected protocol error name.
function assertError(
  messages: HarnessParsedMessage[],
  expectedName: string,
  context: string
): void {
  const error = findMessage(messages, "error") as { name?: unknown } | undefined;
  assert.ok(error, `expected error during ${context}`);
  assert.equal(error.name, expectedName);
}

// Waits briefly and asserts that no ihaveobject gossip for the object was sent.
async function assertNoIHaveObject(
  peer: Awaited<ReturnType<typeof openPeer>>,
  objectId: string,
  timeoutMs = 500
): Promise<void> {
  await assert.rejects(
    peer.waitFor(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        (message as Record<string, unknown>).type === "ihaveobject" &&
        (message as Record<string, unknown>).objectid === objectId,
      timeoutMs
    ),
    /timeout/
  );
}

// Produces a deterministic nonce tweak that breaks the assignment block's proof of work.
function makeInvalidPowBlock(): Block {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const block = {
      ...ASSIGNMENT_BLOCK,
      nonce: attempt.toString(16).padStart(64, "0")
    };
    const blockId = computeObjectId(block);
    if (BigInt(`0x${blockId}`) >= BigInt(`0x${block.T}`)) {
      return block;
    }
  }

  throw new Error("failed to construct invalid pow block");
}

// Creates a lookup object for direct block-state validation tests.
function createObjectLookup(options: {
  objects: Map<string, ApplicationObject>;
  parentUtxo?: UtxoSnapshot;
}): {
  getObject: (key: string) => Promise<ApplicationObject>;
  getUtxo: (blockId: string) => Promise<UtxoSnapshot>;
  putUtxo: (blockId: string, snapshot: UtxoSnapshot) => Promise<void>;
  requestObject: (objectId: string) => void;
  waitForObject: (objectId: string, timeoutMs: number) => Promise<ApplicationObject>;
} {
  const parentUtxo = options.parentUtxo ?? { entries: [] };
  const genesisWithMetadata: BlockWithMetadata = {
    type: "blockwithmetadata",
    block: GENESIS_BLOCK,
    height: 0
  };

  return {
    getObject: async (key: string): Promise<ApplicationObject> => {
      if (key === GENESIS_BLOCK_ID) {
        return genesisWithMetadata;
      }

      const object = options.objects.get(key);
      if (object !== undefined) {
        return object;
      }

      const error = new Error(`missing object ${key}`) as Error & {
        notFound?: boolean;
      };
      error.name = "NotFoundError";
      error.notFound = true;
      throw error;
    },
    getUtxo: async (blockId: string): Promise<UtxoSnapshot> => {
      if (blockId === GENESIS_BLOCK_ID) {
        return parentUtxo;
      }

      const error = new Error(`missing utxo ${blockId}`) as Error & {
        notFound?: boolean;
      };
      error.name = "NotFoundError";
      error.notFound = true;
      throw error;
    },
    putUtxo: async (): Promise<void> => {},
    requestObject: (): void => {},
    waitForObject: async (objectId: string): Promise<ApplicationObject> => {
      const error = new Error(`missing object ${objectId}`) as Error & {
        notFound?: boolean;
      };
      error.name = "NotFoundError";
      error.notFound = true;
      throw error;
    }
  };
}

// Asserts that direct state validation fails with the expected application error.
async function assertValidationError(
  object: ApplicationObject,
  expectedName: ErrorName,
  objectLookup: ReturnType<typeof createObjectLookup>,
  context: string
): Promise<void> {
  await assert.rejects(
    validateApplicationObjectState(object, objectLookup),
    (error: unknown) => {
      assert.ok(
        error instanceof ApplicationObjectValidationError,
        `expected ApplicationObjectValidationError during ${context}`
      );
      assert.equal(error.errorName, expectedName);
      return true;
    }
  );
}

test("PSET3: invalid target block returns INVALID_FORMAT and is not gossiped", async () => {
  await withTestNode(async ({ host, port }) => {
    const peer = await openPeer({ host, port, waitMs: 600 });
    try {
      const invalidTargetBlock: Block = {
        ...ASSIGNMENT_BLOCK,
        T: "00000000abd00000000000000000000000000000000000000000000000000000"
      };

      const responses = await sendLines({
        host,
        port,
        lines: [
          JSON.stringify(HELLO),
          JSON.stringify({ type: "object", object: invalidTargetBlock })
        ]
      });

      assertError(responses, "INVALID_FORMAT", "invalid block target");
      await assertNoIHaveObject(peer, computeObjectId(invalidTargetBlock));
    } finally {
      peer.socket.end();
    }
  });
});

test("PSET3: invalid proof-of-work block returns INVALID_BLOCK_POW and is not gossiped", async () => {
  await withTestNode(async ({ host, port }) => {
    const peer = await openPeer({ host, port, waitMs: 600 });
    try {
      const invalidPowBlock = makeInvalidPowBlock();

      const responses = await sendLines({
        host,
        port,
        lines: [
          JSON.stringify(HELLO),
          JSON.stringify({ type: "object", object: invalidPowBlock })
        ]
      });

      assertError(responses, "INVALID_BLOCK_POW", "invalid block pow");
      await assertNoIHaveObject(peer, computeObjectId(invalidPowBlock));
    } finally {
      peer.socket.end();
    }
  });
});

test("PSET3: block with missing transaction returns UNFINDABLE_OBJECT and is not gossiped", async () => {
  await withTestNode(async ({ host, port }) => {
    const peer = await openPeer({ host, port, waitMs: 4_500 });
    try {
      const responses = await sendLines({
        host,
        port,
        waitMs: 4_500,
        lines: [
          JSON.stringify(HELLO),
          JSON.stringify({ type: "object", object: ASSIGNMENT_BLOCK })
        ]
      });

      assertError(responses, "UNFINDABLE_OBJECT", "block with missing transaction");

      const requestedTx = peer.messages.some(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          (message as Record<string, unknown>).type === "getobject" &&
          (message as Record<string, unknown>).objectid === ASSIGNMENT_TX_ID
      );
      assert.ok(requestedTx, "expected missing transaction to be requested from peers");

      await assertNoIHaveObject(peer, ASSIGNMENT_BLOCK_ID);
    } finally {
      peer.socket.end();
    }
  });
});

test("PSET3: valid block is accepted and gossiped with ihaveobject", async () => {
  await withTestNode(async ({ host, port }) => {
    const seedResponses = await sendLines({
      host,
      port,
      lines: [
        JSON.stringify(HELLO),
        JSON.stringify({ type: "object", object: ASSIGNMENT_TX })
      ]
    });
    assertNoError(seedResponses, "assignment transaction seed");

    const peer = await openPeer({ host, port, waitMs: 1_000 });
    try {
      const responses = await sendLines({
        host,
        port,
        lines: [
          JSON.stringify(HELLO),
          JSON.stringify({ type: "object", object: ASSIGNMENT_BLOCK })
        ]
      });

      assertNoError(responses, "valid block");

      const ihave = await peer.waitFor(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          (message as Record<string, unknown>).type === "ihaveobject" &&
          (message as Record<string, unknown>).objectid === ASSIGNMENT_BLOCK_ID,
        1_500
      );
      assert.ok(ihave, "expected valid block gossip");
    } finally {
      peer.socket.end();
    }
  });
});

test("PSET3: block transaction that spends outside the parent UTXO set returns INVALID_TX_OUTPOINT", async () => {
  const regularTx: Transaction = {
    type: "transaction",
    inputs: [
      {
        outpoint: {
          txid: "11".repeat(32),
          index: 0
        },
        sig: "00".repeat(64)
      }
    ],
    outputs: [
      {
        pubkey: "b6a95d7b410ae1eb924898ae584d21523b53aa5a78d1bc54abe964fd8e63f487",
        value: 1
      }
    ]
  };

  const objectLookup = createObjectLookup({
    objects: new Map([[ASSIGNMENT_TX_ID, regularTx]])
  });

  await assertValidationError(
    ASSIGNMENT_BLOCK,
    "INVALID_TX_OUTPOINT",
    objectLookup,
    "transaction not in parent utxo"
  );
});

test("PSET3: overclaiming coinbase returns INVALID_BLOCK_COINBASE", async () => {
  const invalidCoinbase: ApplicationObject = {
    type: "transaction",
    height: 1,
    outputs: [
      {
        pubkey: "b6a95d7b410ae1eb924898ae584d21523b53aa5a78d1bc54abe964fd8e63f487",
        value: 50_000_000_000_001
      }
    ]
  };

  const objectLookup = createObjectLookup({
    objects: new Map([[ASSIGNMENT_TX_ID, invalidCoinbase]])
  });

  await assertValidationError(
    ASSIGNMENT_BLOCK,
    "INVALID_BLOCK_COINBASE",
    objectLookup,
    "coinbase overclaim"
  );
});
