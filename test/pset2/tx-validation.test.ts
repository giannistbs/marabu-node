import assert from "node:assert/strict";
import { test } from "node:test";
import canonicalize from "canonicalize";
import { createHash } from "blake2";
import * as ed from "@noble/ed25519";
import {
  HELLO,
  findMessage,
  sendLines,
  withTestNode,
  type ParsedMessage
} from "../helpers/harness.js";


function assertNoError(messages: ParsedMessage[], context: string): void {
  const error = findMessage(messages, "error") as { name?: unknown } | undefined;
  assert.ok(!error, `unexpected error during ${context}`);
}

function assertError(
  messages: ParsedMessage[],
  expectedName: string,
  context: string
): void {
  const error = findMessage(messages, "error") as { name?: unknown } | undefined;
  assert.ok(error, `expected error during ${context}`);
  assert.equal(error.name, expectedName);
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
  validTx: Record<string, unknown>;
  invalidSigTx: Record<string, unknown>;
  invalidOutpointTx: Record<string, unknown>;
  unknownObjectTx: Record<string, unknown>;
  invalidConservationTx: Record<string, unknown>;
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

  const makeTx = async (txid: string, index: number, value: number) => {
    const tx: Record<string, unknown> = {
      type: "transaction",
      inputs: [{ outpoint: { txid, index }, sig: "" }],
      outputs: [{ pubkey: pubHex, value }]
    };
    const sig = await signTransaction(tx, priv);
    (tx.inputs as Record<string, unknown>[])[0].sig = sig;
    return tx;
  };

  const validTx = await makeTx(coinbaseId, 0, 10);
  const invalidOutpointTx = await makeTx(coinbaseId, 1, 10);
  const unknownObjectTx = await makeTx("00".repeat(32), 0, 10);
  const invalidConservationTx = await makeTx(coinbaseId, 0, 60);
  const invalidSigTx: Record<string, unknown> = {
    ...validTx,
    inputs: [
      {
        ...(validTx.inputs as Record<string, unknown>[])[0],
        sig: "00".repeat(64)
      }
    ]
  };

  return {
    coinbase,
    coinbaseId,
    validTx,
    invalidSigTx,
    invalidOutpointTx,
    unknownObjectTx,
    invalidConservationTx
  };
}

test("PSET2: transaction validation", async () => {
  await withTestNode(async ({ host, port }) => {
    const vectors = await buildVectors();
    const helloLine = JSON.stringify(HELLO);

    const seedResponses = await sendLines({
      host,
      port,
      lines: [helloLine, JSON.stringify({ type: "object", object: vectors.coinbase })]
    });
    assertNoError(seedResponses, "coinbase seed");

    const validResponses = await sendLines({
      host,
      port,
      lines: [helloLine, JSON.stringify({ type: "object", object: vectors.validTx })]
    });
    assertNoError(validResponses, "valid transaction");

    const unknownResponses = await sendLines({
      host,
      port,
      lines: [helloLine, JSON.stringify({ type: "object", object: vectors.unknownObjectTx })]
    });
    assertError(unknownResponses, "UNKNOWN_OBJECT", "unknown outpoint");

    const invalidSigResponses = await sendLines({
      host,
      port,
      lines: [helloLine, JSON.stringify({ type: "object", object: vectors.invalidSigTx })]
    });
    assertError(invalidSigResponses, "INVALID_TX_SIGNATURE", "invalid signature");

    const invalidOutpointResponses = await sendLines({
      host,
      port,
      lines: [helloLine, JSON.stringify({ type: "object", object: vectors.invalidOutpointTx })]
    });
    assertError(
      invalidOutpointResponses,
      "INVALID_TX_OUTPOINT",
      "invalid outpoint index"
    );

    const invalidConservationResponses = await sendLines({
      host,
      port,
      lines: [
        helloLine,
        JSON.stringify({ type: "object", object: vectors.invalidConservationTx })
      ]
    });
    assertError(
      invalidConservationResponses,
      "INVALID_TX_CONSERVATION",
      "invalid conservation"
    );

    const invalidFormatResponses = await sendLines({
      host,
      port,
      lines: [
        helloLine,
        JSON.stringify({
          type: "object",
          object: { type: "transaction", inputs: "not-array", outputs: [] }
        })
      ]
    });
    assertError(invalidFormatResponses, "INVALID_FORMAT", "invalid format");
  });
});
