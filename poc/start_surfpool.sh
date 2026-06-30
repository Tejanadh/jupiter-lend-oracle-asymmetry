#!/usr/bin/env bash
# Start Surfpool mainnet fork for Jupiter Lend PoC harness
#
# IMPORTANT: This is a SERVER — it runs in the foreground and prints little output.
# Leave this terminal open. Run tests in a SECOND terminal.
set -euo pipefail

PORT="${SURFPOOL_PORT:-8899}"
WS_PORT="${SURFPOOL_WS_PORT:-$((PORT + 1))}"
RPC="http://127.0.0.1:${PORT}"

echo "=============================================="
echo "  Surfpool mainnet fork"
echo "=============================================="
echo "  RPC:     ${RPC}"
echo "  WS:      ws://127.0.0.1:${WS_PORT}"
echo "  Studio:  http://127.0.0.1:18488"
echo ""
echo "  This terminal must stay open (server process)."
echo "  In a SECOND terminal, run:"
echo "    cd $(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "    LOCAL_RPC=${RPC} npm run test:staleness"
echo "=============================================="
echo ""

# Check port not already taken
if curl -s --max-time 1 "${RPC}" -X POST \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getVersion"}' >/dev/null 2>&1; then
  echo "NOTE: RPC port ${PORT} already responding — Surfpool may already be running."
  echo "      Skip start and run tests directly:"
  echo "      LOCAL_RPC=${RPC} npm run test:staleness"
  echo ""
  read -r -p "Start another instance anyway? [y/N] " ans
  if [[ "${ans,,}" != "y" ]]; then
    echo "Exiting. Use existing instance on port ${PORT}."
    exit 0
  fi
fi

ARGS=(
  start
  --network mainnet
  --no-tui
  --ci
  --port "$PORT"
  --ws-port "$WS_PORT"
  --airdrop-amount 10000000000
)

echo "Starting: surfpool ${ARGS[*]}"
echo "(First startup can take 10-30s before RPC accepts requests)"
echo ""

# Start in background briefly to poll for readiness, then bring to foreground
surfpool "${ARGS[@]}" &
SP_PID=$!

for i in $(seq 1 60); do
  if curl -s --max-time 1 "${RPC}" -X POST \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"getVersion"}' 2>/dev/null | grep -q surfnet-version; then
    echo ""
    echo "✓ Surfpool READY on ${RPC}"
    echo "  Open another terminal and run your tests now."
    echo ""
    break
  fi
  sleep 1
  if ! kill -0 "$SP_PID" 2>/dev/null; then
    echo "ERROR: surfpool exited during startup"
    wait "$SP_PID" || true
    exit 1
  fi
done

# Hand foreground back to surfpool (keeps server alive in this terminal)
wait "$SP_PID"
