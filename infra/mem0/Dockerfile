# Wabi self-hosted mem0: env-driven hybrid graph+vector mem0 server.
# See ADR-0025 (hybrid graph+vector memory), ADR-0017, and remediation issues #04 / #23 / #37.
#
# We build on python:3.11-slim rather than mem0/mem0-api-server because that image is
# published arm64-only (fine on Apple Silicon, but Railway/x86 builders fail with
# "no match for platform in manifest"). We override the server anyway (main.py + config.py),
# so the stock image bought us nothing but the deps below.
FROM python:3.11-slim

WORKDIR /app

# mem0 with the [graph] extra (langchain-neo4j, neo4j, rank-bm25) + the FastAPI server deps
# our main.py imports. Pin mem0 so it isn't silently upgraded.
RUN pip install --no-cache-dir \
    "mem0ai[graph]==0.1.117" \
    fastapi \
    "uvicorn[standard]" \
    python-dotenv

# Our env-driven config + server (config.py is imported by main.py).
COPY config.py /app/config.py
COPY main.py /app/main.py

EXPOSE 8081

# Serve on 8081 for prod parity with docker-compose.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8081"]
