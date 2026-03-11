#!/usr/bin/env bash
set -euo pipefail

HOST="${1:-}"
PORT="${2:-18018}"
TIMEOUT=5
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -z "$HOST" ]]; then
  echo "Usage: $0 <host> [port]"
  echo "  host  IP address or hostname of the Marabu node"
  echo "  port  TCP port (default: 18018)"
  exit 1
fi

TARGET="$HOST:$PORT"

pass() { printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { printf "  \033[31m✗\033[0m %s\n" "$1"; }
info() { printf "  \033[36m→\033[0m %s\n" "$1"; }
header() { printf "\n\033[1m[ %s ]\033[0m\n" "$1"; }

send_and_receive() {
  local payload="$1"
  { printf '%s' "$payload"; sleep "$TIMEOUT"; } | nc -w "$((TIMEOUT + 1))" "$HOST" "$PORT" 2>/dev/null
}

send_messages() {
  { for msg in "$@"; do printf '%s\n' "$msg"; done; sleep "$TIMEOUT"; } | nc -w "$((TIMEOUT + 1))" "$HOST" "$PORT" 2>/dev/null || true
}

random_objectid() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  elif command -v python3 >/dev/null 2>&1; then
    python3 - <<'PY'
import os
print(os.urandom(32).hex())
PY
  else
    head -c 32 /dev/urandom | xxd -p -c 64
  fi
}

extract_error_payload() {
  echo "$1" | tr -d '\r' | grep -m1 '"type":"error"' || true
}

extract_error_name() {
  local payload
  payload=$(extract_error_payload "$1")
  if [[ -z "$payload" ]]; then
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    node -e 'const fs=require("fs");const line=fs.readFileSync(0,"utf8").trim();if(!line)process.exit(0);try{const obj=JSON.parse(line);if(obj&&typeof obj.name==="string"){console.log(obj.name);}}catch{}' <<<"$payload"
    return 0
  fi
  echo "$payload" | sed -n 's/.*"name"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' || true
}

print_error_payload() {
  local payload
  payload=$(extract_error_payload "$1")
  if [[ -n "$payload" ]]; then
    info "Error payload: $payload"
  fi
}

expect_error() {
  local response="$1"
  local expected="$2"
  local label="$3"
  local actual
  if echo "$response" | grep -q '"type":"error"'; then
    actual=$(extract_error_name "$response")
    if [[ "$actual" == "$expected" ]]; then
      pass "$label"
    else
      fail "$label (expected $expected, got ${actual:-unknown})"
    fi
    if [[ -n "$actual" ]]; then
      info "Error name: $actual"
    else
      print_error_payload "$response"
    fi
  else
    fail "$label (no error response)"
  fi
}

expect_no_error() {
  local response="$1"
  local label="$2"
  if echo "$response" | grep -q '"type":"error"'; then
    local actual
    actual=$(extract_error_name "$response")
    if [[ -n "$actual" ]]; then
      fail "$label (received $actual)"
    else
      fail "$label (received error)"
      print_error_payload "$response"
    fi
  else
    pass "$label"
  fi
}

listen_for_messages() {
  local outfile="$1"
  local hold="${2:-$((TIMEOUT + 2))}"
  if command -v node >/dev/null 2>&1; then
    HOST="$HOST" PORT="$PORT" HOLD="$hold" HELLO="$HELLO" node --input-type=module - <<'NODE' > "$outfile" &
import net from "node:net";

const host = process.env.HOST;
const port = Number(process.env.PORT);
const holdMs = Number(process.env.HOLD) * 1000;
const hello = process.env.HELLO ?? '{"type":"hello","version":"0.10.0"}';

const socket = net.createConnection({ host, port }, () => {
  socket.write(`${hello}\n`);
});

socket.on("data", (chunk) => {
  process.stdout.write(chunk.toString("utf8"));
});

socket.setTimeout(holdMs + 2000, () => socket.end());
setTimeout(() => socket.end(), holdMs);
NODE
  else
    (
      { printf '%s\n' "$HELLO"; sleep "$hold"; } | nc -w "$((hold + 2))" "$HOST" "$PORT" 2>/dev/null > "$outfile"
    ) &
  fi
  echo $!
}

prepare_pset2_vectors() {
  if ! command -v node >/dev/null 2>&1; then
    return 1
  fi
  local data
  if ! data=$(node --import tsx --import "$SCRIPT_DIR/../src/crypto/ed25519.ts" --input-type=module - <<'NODE'
import canonicalize from "canonicalize";
import { createHash } from "blake2";
import * as ed from "@noble/ed25519";
import { randomBytes } from "node:crypto";

const privHex = "11".repeat(32);
const priv = ed.etc.hexToBytes(privHex);
const pubHex = ed.etc.bytesToHex(ed.getPublicKey(priv));

const objectId = (obj) => {
  const encoded = canonicalize(obj);
  if (typeof encoded !== "string") throw new Error("canonicalize failed");
  const h = createHash("blake2s");
  h.update(Buffer.from(encoded));
  return h.digest("hex");
};

const signTx = async (tx) => {
  const payload = {
    ...tx,
    inputs: tx.inputs.map((input) => ({ ...input, sig: null }))
  };
  const encoded = canonicalize(payload);
  if (typeof encoded !== "string") throw new Error("canonicalize failed");
  const sig = await ed.signAsync(Buffer.from(encoded), priv);
  return ed.etc.bytesToHex(sig);
};

const coinbase = {
  type: "transaction",
  height: 0,
  outputs: [{ pubkey: pubHex, value: 50 }]
};
const coinbaseId = objectId(coinbase);
const coinbase2 = {
  type: "transaction",
  height: 1,
  outputs: [{ pubkey: pubHex, value: 40 }]
};
const coinbase2Id = objectId(coinbase2);

const makeTx = async ({ txid, index, value }) => {
  const tx = {
    type: "transaction",
    inputs: [{ outpoint: { txid, index }, sig: null }],
    outputs: [{ pubkey: pubHex, value }]
  };
  const sig = await signTx(tx);
  tx.inputs[0].sig = sig;
  return tx;
};

const validTx = await makeTx({ txid: coinbaseId, index: 0, value: 10 });
const gossipValue = 1 + (randomBytes(2).readUInt16BE(0) % 39);
const gossipRemainder = 40 - gossipValue;
const randomPubHex = randomBytes(32).toString("hex");
const gossipTx = {
  type: "transaction",
  inputs: [{ outpoint: { txid: coinbase2Id, index: 0 }, sig: null }],
  outputs: [
    { pubkey: pubHex, value: gossipValue },
    { pubkey: randomPubHex, value: gossipRemainder }
  ]
};
const gossipSig = await signTx(gossipTx);
gossipTx.inputs[0].sig = gossipSig;
const invalidConservationTx = await makeTx({ txid: coinbaseId, index: 0, value: 60 });
const invalidOutpointTx = await makeTx({ txid: coinbaseId, index: 1, value: 10 });
const unknownObjectTx = await makeTx({ txid: "00".repeat(32), index: 0, value: 10 });
const invalidSigTx = {
  ...validTx,
  inputs: [{ ...validTx.inputs[0], sig: "00".repeat(64) }]
};

const encode = (obj) => {
  const encoded = canonicalize(obj);
  if (typeof encoded !== "string") throw new Error("canonicalize failed");
  return encoded;
};

const lines = [
  ["PUBKEY", pubHex],
  ["COINBASE_OBJ", encode(coinbase)],
  ["COINBASE_ID", coinbaseId],
  ["COINBASE2_OBJ", encode(coinbase2)],
  ["COINBASE2_ID", coinbase2Id],
  ["VALID_TX_OBJ", encode(validTx)],
  ["VALID_TX_ID", objectId(validTx)],
  ["GOSSIP_TX_OBJ", encode(gossipTx)],
  ["GOSSIP_TX_ID", objectId(gossipTx)],
  ["INVALID_SIG_TX_OBJ", encode(invalidSigTx)],
  ["INVALID_OUTPOINT_TX_OBJ", encode(invalidOutpointTx)],
  ["UNKNOWN_OBJECT_TX_OBJ", encode(unknownObjectTx)],
  ["INVALID_CONSERVATION_TX_OBJ", encode(invalidConservationTx)]
];

for (const [key, value] of lines) {
  console.log(`${key}:${value}`);
}
NODE
  ); then
    return 1
  fi

  PUBKEY=$(echo "$data" | sed -n 's/^PUBKEY://p')
  COINBASE_OBJ=$(echo "$data" | sed -n 's/^COINBASE_OBJ://p')
  COINBASE_ID=$(echo "$data" | sed -n 's/^COINBASE_ID://p')
  COINBASE2_OBJ=$(echo "$data" | sed -n 's/^COINBASE2_OBJ://p')
  COINBASE2_ID=$(echo "$data" | sed -n 's/^COINBASE2_ID://p')
  VALID_TX_OBJ=$(echo "$data" | sed -n 's/^VALID_TX_OBJ://p')
  VALID_TX_ID=$(echo "$data" | sed -n 's/^VALID_TX_ID://p')
  GOSSIP_TX_OBJ=$(echo "$data" | sed -n 's/^GOSSIP_TX_OBJ://p')
  GOSSIP_TX_ID=$(echo "$data" | sed -n 's/^GOSSIP_TX_ID://p')
  INVALID_SIG_TX_OBJ=$(echo "$data" | sed -n 's/^INVALID_SIG_TX_OBJ://p')
  INVALID_OUTPOINT_TX_OBJ=$(echo "$data" | sed -n 's/^INVALID_OUTPOINT_TX_OBJ://p')
  UNKNOWN_OBJECT_TX_OBJ=$(echo "$data" | sed -n 's/^UNKNOWN_OBJECT_TX_OBJ://p')
  INVALID_CONSERVATION_TX_OBJ=$(echo "$data" | sed -n 's/^INVALID_CONSERVATION_TX_OBJ://p')
  return 0
}

# ── 1. TCP connectivity ──────────────────────────────────────────────
header "Problem Set 1 (current baseline)"
info "Running PSET 1 tests: handshake, peers, basic error handling."

header "TCP connectivity to $TARGET"

if nc -z -w "$TIMEOUT" "$HOST" "$PORT" 2>/dev/null; then
  pass "Port $PORT is open"
else
  fail "Cannot reach $TARGET — check firewall / security group"
  exit 1
fi

# ── 2. Hello handshake ───────────────────────────────────────────────
header "Hello handshake"

HELLO='{"type":"hello","version":"0.10.0"}'
RESPONSE=$( { printf '%s\n' "$HELLO"; sleep 2; } | nc -w "$TIMEOUT" "$HOST" "$PORT" 2>/dev/null || true)

if echo "$RESPONSE" | grep -q '"type":"hello"'; then
  pass "Received hello response"
  AGENT=$(echo "$RESPONSE" | head -1 | sed -n 's/.*"agent":"\\([^"]*\\)".*/\\1/p')
  VERSION=$(echo "$RESPONSE" | head -1 | sed -n 's/.*"version":"\\([^"]*\\)".*/\\1/p')
  [[ -n "$AGENT" ]] && info "Agent:   $AGENT"
  [[ -n "$VERSION" ]] && info "Version: $VERSION"
else
  fail "No hello response received"
fi

# ── 3. Getpeers ──────────────────────────────────────────────────────
header "Peer discovery (getpeers)"

RESPONSE=$( { printf '%s\n' "$HELLO"; printf '%s\n' '{"type":"getpeers"}'; sleep 2; } | nc -w "$TIMEOUT" "$HOST" "$PORT" 2>/dev/null || true)

PEERS_LINE=$(echo "$RESPONSE" | grep '"type":"peers"' || true)
if [[ -n "$PEERS_LINE" ]]; then
  pass "Received peers response"
  COUNT=$(echo "$PEERS_LINE" | tr ',' '\n' | grep -c ':' || true)
  info "Peer count: ~$COUNT"
else
  fail "No peers response received"
fi

# ── 4. Invalid message handling ──────────────────────────────────────
header "Error handling — message before hello"

RESPONSE=$( { printf '%s\n' '{"type":"getpeers"}'; sleep 2; } | nc -w "$TIMEOUT" "$HOST" "$PORT" 2>/dev/null || true)

if echo "$RESPONSE" | grep -q '"type":"error"'; then
  pass "Node correctly rejected message before hello"
  ERR_NAME=$(extract_error_name "$RESPONSE")
  if [[ -n "$ERR_NAME" ]]; then
    info "Error name: $ERR_NAME"
  else
    print_error_payload "$RESPONSE"
  fi
else
  fail "Expected an error response for missing handshake"
fi

# ── 5. Malformed JSON ────────────────────────────────────────────────
header "Error handling — malformed JSON"

RESPONSE=$( { printf '%s\n' "$HELLO"; printf '%s\n' 'this is not json'; sleep 2; } | nc -w "$TIMEOUT" "$HOST" "$PORT" 2>/dev/null || true)

if echo "$RESPONSE" | grep -q '"type":"error"'; then
  pass "Node correctly rejected malformed JSON"
  ERR_NAME=$(extract_error_name "$RESPONSE")
  if [[ -n "$ERR_NAME" ]]; then
    info "Error name: $ERR_NAME"
  else
    print_error_payload "$RESPONSE"
  fi
else
  fail "Expected an error response for malformed JSON"
fi

# ── 6. Unknown message type ──────────────────────────────────────────
header "Error handling — unknown message type"

RESPONSE=$( { printf '%s\n' "$HELLO"; printf '%s\n' '{"type":"foobar"}'; sleep 2; } | nc -w "$TIMEOUT" "$HOST" "$PORT" 2>/dev/null || true)

if echo "$RESPONSE" | grep -q '"type":"error"'; then
  pass "Node correctly rejected unknown message type"
  ERR_NAME=$(extract_error_name "$RESPONSE")
  if [[ -n "$ERR_NAME" ]]; then
    info "Error name: $ERR_NAME"
  else
    print_error_payload "$RESPONSE"
  fi
else
  fail "Expected an error response for unknown type"
fi

# ── Summary ──────────────────────────────────────────────────────────
header "Problem Set 2 (object exchange + transaction validation)"

if prepare_pset2_vectors; then
  info "PSET 2 test vectors ready (coinbase pubkey: ${PUBKEY:0:12}...)."

  # Seed coinbase into the object store.
  header "PSET2 Seed — store coinbase"
  RESPONSE=$(send_messages "$HELLO" "{\"type\":\"object\",\"object\":$COINBASE_OBJ}")
  expect_no_error "$RESPONSE" "Coinbase accepted"

  header "PSET2 Seed — store coinbase (height 1)"
  RESPONSE=$(send_messages "$HELLO" "{\"type\":\"object\",\"object\":$COINBASE2_OBJ}")
  expect_no_error "$RESPONSE" "Second coinbase accepted"

  # ── Object exchange ──────────────────────────────────────────────
  header "PSET2 Object exchange — ihaveobject triggers getobject"
  UNKNOWN_ID=$(random_objectid)
  RESPONSE=$(send_messages "$HELLO" "{\"type\":\"ihaveobject\",\"objectid\":\"$UNKNOWN_ID\"}")
  if echo "$RESPONSE" | grep -q '"type":"getobject"'; then
    pass "Received getobject request"
  else
    fail "Expected getobject in response to ihaveobject"
  fi

  header "PSET2 Object exchange — gossip to peers (ihaveobject)"
  GOSSIP_LOG=$(mktemp)
  GOSSIP_PID=$(listen_for_messages "$GOSSIP_LOG" "$((TIMEOUT + 3))")
  sleep 1
  RESPONSE=$(send_messages "$HELLO" "{\"type\":\"object\",\"object\":$COINBASE2_OBJ}" "{\"type\":\"object\",\"object\":$GOSSIP_TX_OBJ}")
  expect_no_error "$RESPONSE" "Gossip transaction accepted"
  wait "$GOSSIP_PID" 2>/dev/null || true
  if grep -q '"type":"ihaveobject"' "$GOSSIP_LOG" && grep -q "$GOSSIP_TX_ID" "$GOSSIP_LOG"; then
    pass "Peer received ihaveobject gossip"
  else
    fail "Expected ihaveobject gossip to peer"
    info "Captured messages:"
    sed -n '1,120p' "$GOSSIP_LOG" | sed 's/^/  /'
  fi
  rm -f "$GOSSIP_LOG"

  header "PSET2 Object exchange — getobject returns stored object"
  RESPONSE=$(send_messages "$HELLO" "{\"type\":\"getobject\",\"objectid\":\"$COINBASE_ID\"}")
  if echo "$RESPONSE" | grep -q '"type":"object"' && echo "$RESPONSE" | grep -q "\"height\":0"; then
    pass "Received object for stored coinbase"
  else
    fail "Did not receive expected object for stored coinbase"
  fi

  header "PSET2 Object exchange — object stored and retrievable"
  RESPONSE=$(send_messages "$HELLO" "{\"type\":\"object\",\"object\":$VALID_TX_OBJ}" "{\"type\":\"getobject\",\"objectid\":\"$VALID_TX_ID\"}")
  if echo "$RESPONSE" | grep -q '"type":"object"' && echo "$RESPONSE" | grep -q "\"txid\""; then
    pass "Received object for stored transaction"
  else
    fail "Did not receive expected object for stored transaction"
  fi

  # ── Transaction validation ───────────────────────────────────────
  header "PSET2 Transaction validation — valid transaction accepted"
  RESPONSE=$(send_messages "$HELLO" "{\"type\":\"object\",\"object\":$VALID_TX_OBJ}")
  expect_no_error "$RESPONSE" "Valid transaction accepted"

  header "PSET2 Transaction validation — unknown outpoint"
  RESPONSE=$(send_messages "$HELLO" "{\"type\":\"object\",\"object\":$UNKNOWN_OBJECT_TX_OBJ}")
  expect_error "$RESPONSE" "UNKNOWN_OBJECT" "Unknown outpoint rejected"

  header "PSET2 Transaction validation — invalid signature"
  RESPONSE=$(send_messages "$HELLO" "{\"type\":\"object\",\"object\":$INVALID_SIG_TX_OBJ}")
  expect_error "$RESPONSE" "INVALID_TX_SIGNATURE" "Invalid signature rejected"

  header "PSET2 Transaction validation — invalid outpoint index"
  RESPONSE=$(send_messages "$HELLO" "{\"type\":\"object\",\"object\":$INVALID_OUTPOINT_TX_OBJ}")
  expect_error "$RESPONSE" "INVALID_TX_OUTPOINT" "Invalid outpoint index rejected"

  header "PSET2 Transaction validation — invalid conservation"
  RESPONSE=$(send_messages "$HELLO" "{\"type\":\"object\",\"object\":$INVALID_CONSERVATION_TX_OBJ}")
  expect_error "$RESPONSE" "INVALID_TX_CONSERVATION" "Invalid conservation rejected"

  header "PSET2 Transaction validation — invalid format"
  RESPONSE=$(send_messages "$HELLO" '{"type":"object","object":{"type":"transaction","inputs":"not-array","outputs":[]}}')
  expect_error "$RESPONSE" "INVALID_FORMAT" "Invalid format rejected"
else
  info "Node.js or dependencies missing; skipping PSET 2 tests."
fi

header "Done"
echo "  All tests against $TARGET completed."
echo ""
