#!/usr/bin/env bash
set -euo pipefail

echo "Cleaning up ./artifacts and ./build directories..."
ARCIUM_COMPOSE_PROJECT="${ARCIUM_COMPOSE_PROJECT:-opportunity_markets_arcium}"

if command -v docker >/dev/null 2>&1; then
  if [ -f ./artifacts/docker-compose-arx-env.yml ]; then
    docker compose -p artifacts -f ./artifacts/docker-compose-arx-env.yml down --remove-orphans || true
    docker compose -p "$ARCIUM_COMPOSE_PROJECT" -f ./artifacts/docker-compose-arx-env.yml down --remove-orphans || true
  fi

  ARCIUM_CONTAINERS=$(
    {
      docker ps -aq --filter "label=com.docker.compose.project=artifacts"
      docker ps -aq --filter "label=com.docker.compose.project=$ARCIUM_COMPOSE_PROJECT"
    } | sort -u
  )
  if [ -n "$ARCIUM_CONTAINERS" ]; then
    docker rm -f $ARCIUM_CONTAINERS || true
  fi
fi

rm -rf ./artifacts ./build
rm -rf ./.anchor/test-ledger ./test-ledger

# Free localnet ports before setup (stale validators/nodes block arcium).
STALE_PID=$(lsof -ti :8899,8900,9091,9092 || true)
if [ -n "$STALE_PID" ]; then
  echo "Killing stale localnet process(es): $STALE_PID"
  kill $STALE_PID
  sleep 1
fi

./build.sh --env dev

# Unit tests (host-native, fast — run before spinning up the validator)
echo "Running unit tests..."
cargo test -p opportunity_market --lib --features disable-prod-guardrails

echo "Running integration tests..."
COMPOSE_PROJECT_NAME="$ARCIUM_COMPOSE_PROJECT" arcium test --skip-build
