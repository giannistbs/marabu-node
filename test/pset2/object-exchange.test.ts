import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import canonicalize from "canonicalize";
import { createHash } from "blake2";
import * as ed from "@noble/ed25519";
import {
  HELLO,
  findMessage,
  openPeer,
  sendLines,
  withTestNode,
  type ParsedMessage
} from "../helpers/harness.js";


function assertNoError(messages: ParsedMessage[], context: string): void {
  const error = findMessage(messages, "error") as { name?: unknown } | undefined;
  assert.ok(!error, `unexpected error during ${context}`);
}

function randomObjectId(): string {
  return randomBytes(32).toString("hex");
}

function encodeCanonical(value: unknown): string {
  const encoded = canonicalize(value);
  if (typeof encoded !== "string") {
    throw new Error("canonicalize failed");
  }
  return encoded;
}

function objectId(value: unknown): string {
  const h = createHash("blake2s");
  h.update(Buffer.from(encodeCanonical(value)));
  return h.digest("hex");
}

async function signTransaction(
  transaction: Record<string, unknown>,
  privateKey: Uint8Array
): Promise<string> {
  const payload = {
    ...transaction,
    inputs: (transaction.inputs as Record<string, unknown>[]).map((input) => ({
      ...input,
      sig: null
    }))
  };
  const encoded = encodeCanonical(payload);
  const sig = await ed.signAsync(Buffer.from(encoded), privateKey);
  return ed.etc.bytesToHex(sig);
}

async function buildVectors(): Promise<{
  coinbase: Record<string, unknown>;
  coinbaseId: string;
  gossipTx: Record<string, unknown>;
  gossipTxId: string;
}> {
  const privHex = "11".repeat(32);
  const priv = ed.etc.hexToBytes(privHex);
  const pubHex = ed.etc.bytesToHex(ed.getPublicKey(priv));

  const coinbase = {
    type: "transaction",
    height: 0,
    outputs: [{ pubkey: pubHex, value: 50 }]
  };
  const coinbaseId = objectId(coinbase);

  const gossipTx: Record<string, unknown> = {
    type: "transaction",
    inputs: [{ outpoint: { txid: coinbaseId, index: 0 }, sig: "" }],
    outputs: [{ pubkey: pubHex, value: 10 }]
  };
  const sig = await signTransaction(gossipTx, priv);
  (gossipTx.inputs as Record<string, unknown>[])[0].sig = sig;

  const gossipTxId = objectId(gossipTx);

  return { coinbase, coinbaseId, gossipTx, gossipTxId };
}

test("PSET2: object exchange", async () => {
  await withTestNode(async ({ host, port }) => {
    const vectors = await buildVectors();
    const helloLine = JSON.stringify(HELLO);

    const unknownId = randomObjectId();
    const ihaveResponses = await sendLines({
      host,
      port,
      lines: [helloLine, JSON.stringify({ type: "ihaveobject", objectid: unknownId })]
    });
    const getobject = findMessage(ihaveResponses, "getobject") as
      | { objectid?: unknown }
      | undefined;
    assert.ok(getobject, "expected getobject response");
    assert.equal(getobject.objectid, unknownId);

    const coinbaseResponses = await sendLines({
      host,
      port,
      lines: [helloLine, JSON.stringify({ type: "object", object: vectors.coinbase })]
    });
    assertNoError(coinbaseResponses, "coinbase object");

    const getCoinbaseResponses = await sendLines({
      host,
      port,
      lines: [
        helloLine,
        JSON.stringify({ type: "getobject", objectid: vectors.coinbaseId })
      ]
    });
    const coinbaseObject = findMessage(getCoinbaseResponses, "object") as
      | { object?: { height?: unknown } }
      | undefined;
    assert.ok(coinbaseObject, "expected coinbase object response");
    assert.equal(coinbaseObject.object?.height, 0);

    const peer = await openPeer({ host, port });
    try {
      const gossipResponses = await sendLines({
        host,
        port,
        lines: [helloLine, JSON.stringify({ type: "object", object: vectors.gossipTx })]
      });
      assertNoError(gossipResponses, "gossip transaction");

      const ihave = await peer.waitFor(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          (message as Record<string, unknown>).type === "ihaveobject" &&
          (message as Record<string, unknown>).objectid === vectors.gossipTxId
      );
      assert.ok(ihave, "expected ihaveobject gossip to peer");
    } finally {
      peer.socket.end();
    }

    const getTxResponses = await sendLines({
      host,
      port,
      lines: [
        helloLine,
        JSON.stringify({ type: "getobject", objectid: vectors.gossipTxId })
      ]
    });
    const txObject = findMessage(getTxResponses, "object");
    assert.ok(txObject, "expected transaction object response");
  });
});
