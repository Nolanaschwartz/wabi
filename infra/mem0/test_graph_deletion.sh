#!/usr/bin/env bash
# Integration regression for ADR-0025 / ADR-0004: delete-my-data must purge the user's neo4j
# subgraph, not just the Qdrant vectors. Proves mem0's delete_all (the path the bot's
# deleteAllForUser hits) cascades to neo4j.
#
# OPT-IN: needs Docker AND live inference endpoints (graph entity extraction calls the LLM and
# embedder). Reads them from the repo-root .env (COACH_BASE_URL/MODEL, EMBEDDING_BASE_URL). Run:
#     infra/mem0/test_graph_deletion.sh
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
NET=wabi-graphdel-test
PW=graphdeltest-pw   # neo4j 5 requires >= 8 chars
USER_ID=mem0_graphdel
IMG=wabi-mem0:test

# shellcheck disable=SC1090
set -a; . "$ROOT/.env"; set +a
: "${COACH_BASE_URL:?need COACH_BASE_URL in .env}"
: "${EMBEDDING_BASE_URL:?need EMBEDDING_BASE_URL in .env}"

cleanup() {
  docker rm -f gd-mem0 gd-neo4j gd-qdrant >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

echo "[graphdel] build image + start neo4j/qdrant ..."
docker build -q -t "$IMG" "$DIR" >/dev/null
docker network create "$NET" >/dev/null
docker run -d --name gd-neo4j --network "$NET" -e NEO4J_AUTH=neo4j/$PW -e NEO4J_PLUGINS='["apoc"]' neo4j:5-community >/dev/null
docker run -d --name gd-qdrant --network "$NET" qdrant/qdrant:v1.18.0 >/dev/null
for i in $(seq 1 30); do
  docker exec gd-neo4j cypher-shell -u neo4j -p "$PW" "RETURN 1;" >/dev/null 2>&1 && break
  sleep 2
done

echo "[graphdel] start mem0 (hybrid) ..."
# --restart on-failure: backstop the neo4j-readiness race exactly like docker-compose does.
docker run -d --name gd-mem0 --network "$NET" --restart on-failure:10 \
  -e MEM0_QDRANT_HOST=gd-qdrant -e MEM0_QDRANT_PORT=6333 \
  -e MEM0_GRAPH_URL=bolt://gd-neo4j:7687 -e MEM0_GRAPH_USERNAME=neo4j -e MEM0_GRAPH_PASSWORD=$PW \
  -e MEM0_LLM_BASE_URL="$COACH_BASE_URL" -e MEM0_LLM_MODEL="${COACH_MODEL:-}" -e MEM0_LLM_API_KEY="${COACH_API_KEY:-not-needed}" \
  -e MEM0_EMBEDDER_BASE_URL="$EMBEDDING_BASE_URL/v1" -e MEM0_EMBEDDER_API_KEY="${EMBEDDING_API_KEY:-not-needed}" \
  -e HISTORY_DB_PATH=/tmp/history.db \
  "$IMG" >/dev/null
echo "[graphdel] wait for mem0 /healthz ..."
for i in $(seq 1 30); do
  if docker exec gd-mem0 python -c "import urllib.request; urllib.request.urlopen('http://localhost:8081/healthz',timeout=3)" >/dev/null 2>&1; then
    echo "[graphdel] mem0 healthy after ~$((i*3))s"; break
  fi
  sleep 3
done

q() { docker exec gd-neo4j cypher-shell --format plain -u neo4j -p "$PW" "MATCH (n {user_id:'$USER_ID'}) RETURN count(n);" 2>/dev/null | tail -1; }

echo "[graphdel] add a memory with named entities ..."
docker exec gd-mem0 python -c "
import urllib.request, json
body=json.dumps({'messages':[{'role':'user','content':'Maria adopted a dog named Rex and walks him every morning.'}],'user_id':'$USER_ID'}).encode()
req=urllib.request.Request('http://localhost:8081/memories',data=body,headers={'Content-Type':'application/json'},method='POST')
print('add:', urllib.request.urlopen(req,timeout=180).status)
"
before="$(q)"; echo "[graphdel] neo4j nodes after add: $before"
[ "$before" -gt 0 ] || { echo "FAIL: expected graph nodes after add, got $before"; exit 1; }

echo "[graphdel] delete-my-data (DELETE /memories?user_id) ..."
docker exec gd-mem0 python -c "
import urllib.request
req=urllib.request.Request('http://localhost:8081/memories?user_id=$USER_ID', method='DELETE')
print('delete:', urllib.request.urlopen(req,timeout=60).read().decode())
"
after="$(q)"; echo "[graphdel] neo4j nodes after delete: $after"
[ "$after" -eq 0 ] || { echo "FAIL: graph not purged, $after nodes remain"; exit 1; }

echo "PASS: delete-my-data cascaded to neo4j ($before -> 0 nodes)"
