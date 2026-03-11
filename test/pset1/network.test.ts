import assert from "node:assert/strict";
import { test } from "node:test";
import { HELLO, findMessage, sendLines, withTestNode } from "../helpers/harness.js";

test("PSET1: hello handshake", async () => {
  await withTestNode(async ({ host, port }) => {
    const responses = await sendLines({ host, port, lines: [JSON.stringify(HELLO)] });
    const hello = findMessage(responses, "hello");
    assert.ok(hello, "expected hello response");
  });
});

test("PSET1: getpeers response", async () => {
  await withTestNode(async ({ host, port }) => {
    const responses = await sendLines({
      host,
      port,
      lines: [JSON.stringify(HELLO), JSON.stringify({ type: "getpeers" })]
    });
    const peers = findMessage(responses, "peers") as { peers?: unknown } | undefined;
    assert.ok(peers, "expected peers response");
    assert.ok(Array.isArray(peers.peers), "peers should be an array");
  });
});
