import assert from "node:assert/strict";
import { test } from "node:test";
import { HELLO, findMessage, sendLines, withTestNode } from "../helpers/harness.js";

test("PSET1: error on message before hello", async () => {
  await withTestNode(async ({ host, port }) => {
    const responses = await sendLines({
      host,
      port,
      lines: [JSON.stringify({ type: "getpeers" })]
    });
    const error = findMessage(responses, "error") as { name?: unknown } | undefined;
    assert.ok(error, "expected error response");
    assert.equal(error.name, "INVALID_HANDSHAKE");
  });
});

test("PSET1: malformed JSON rejected", async () => {
  await withTestNode(async ({ host, port }) => {
    const responses = await sendLines({
      host,
      port,
      lines: [JSON.stringify(HELLO), "this is not json"]
    });
    const error = findMessage(responses, "error") as { name?: unknown } | undefined;
    assert.ok(error, "expected error response");
    assert.equal(error.name, "INVALID_FORMAT");
  });
});

test("PSET1: unknown message type rejected", async () => {
  await withTestNode(async ({ host, port }) => {
    const responses = await sendLines({
      host,
      port,
      lines: [JSON.stringify(HELLO), JSON.stringify({ type: "foobar" })]
    });
    const error = findMessage(responses, "error") as { name?: unknown } | undefined;
    assert.ok(error, "expected error response");
    assert.equal(error.name, "INVALID_FORMAT");
  });
});
