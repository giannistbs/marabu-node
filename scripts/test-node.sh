#!/usr/bin/env bash
set -euo pipefail

HOST="${1:-}"
PORT="${2:-18018}"
TIMEOUT=5

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

# ── 1. TCP connectivity ──────────────────────────────────────────────
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
  AGENT=$(echo "$RESPONSE" | head -1 | sed -n 's/.*"agent":"\([^"]*\)".*/\1/p')
  VERSION=$(echo "$RESPONSE" | head -1 | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')
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
  ERR_NAME=$(echo "$RESPONSE" | grep '"type":"error"' | sed -n 's/.*"name":"\([^"]*\)".*/\1/p')
  info "Error name: $ERR_NAME"
else
  fail "Expected an error response for missing handshake"
fi

# ── 5. Malformed JSON ────────────────────────────────────────────────
header "Error handling — malformed JSON"

RESPONSE=$( { printf '%s\n' "$HELLO"; printf '%s\n' 'this is not json'; sleep 2; } | nc -w "$TIMEOUT" "$HOST" "$PORT" 2>/dev/null || true)

if echo "$RESPONSE" | grep -q '"type":"error"'; then
  pass "Node correctly rejected malformed JSON"
  ERR_NAME=$(echo "$RESPONSE" | grep '"type":"error"' | sed -n 's/.*"name":"\([^"]*\)".*/\1/p')
  info "Error name: $ERR_NAME"
else
  fail "Expected an error response for malformed JSON"
fi

# ── 6. Unknown message type ──────────────────────────────────────────
header "Error handling — unknown message type"

RESPONSE=$( { printf '%s\n' "$HELLO"; printf '%s\n' '{"type":"foobar"}'; sleep 2; } | nc -w "$TIMEOUT" "$HOST" "$PORT" 2>/dev/null || true)

if echo "$RESPONSE" | grep -q '"type":"error"'; then
  pass "Node correctly rejected unknown message type"
  ERR_NAME=$(echo "$RESPONSE" | grep '"type":"error"' | sed -n 's/.*"name":"\([^"]*\)".*/\1/p')
  info "Error name: $ERR_NAME"
else
  fail "Expected an error response for unknown type"
fi

# ── Summary ──────────────────────────────────────────────────────────
header "Done"
echo "  All tests against $TARGET completed."
echo ""
