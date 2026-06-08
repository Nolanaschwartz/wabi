#!/usr/bin/env bash
# Acceptance check for ADR-0025: the built Wabi mem0 image must carry the neo4j graph deps.
# The stock mem0/mem0-api-server image ships vector-only, so the Dockerfile adds mem0ai[graph].
# Usage: infra/mem0/test_image_deps.sh   (builds the image, then asserts the imports)
set -euo pipefail

IMAGE="${1:-wabi-mem0:test}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "[test_image_deps] building $IMAGE from $DIR ..."
docker build -q -t "$IMAGE" "$DIR" >/dev/null

echo "[test_image_deps] checking graph imports + config assembly ..."
docker run --rm --entrypoint python "$IMAGE" -c "
import importlib
for m in ('langchain_neo4j', 'neo4j', 'rank_bm25'):
    importlib.import_module(m)        # raises if the [graph] extra is missing
from config import build_config
cfg = build_config({'MEM0_GRAPH_PASSWORD': 'x'})
assert cfg['graph_store']['provider'] == 'neo4j', cfg
print('OK: graph deps present and graph_store assembles')
"
