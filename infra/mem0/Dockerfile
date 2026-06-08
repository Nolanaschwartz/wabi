# Wabi self-hosted mem0: stock image + our env-driven, hybrid graph+vector config.
# See ADR-0025 (hybrid graph+vector memory), ADR-0017, and remediation issues #04 / #23 / #37.
FROM mem0/mem0-api-server:latest

# The stock image ships mem0 vector-only; the neo4j graph store needs the [graph] extra
# (langchain-neo4j, neo4j, rank-bm25). Pin to the image's mem0 version so mem0 isn't upgraded.
RUN pip install --no-cache-dir "mem0ai[graph]==0.1.117"

# Override the stock hardcoded-config server with ours (config.py is imported by main.py).
COPY config.py /app/config.py
COPY main.py /app/main.py

EXPOSE 8081

# Stock CMD binds --port 8000 with --reload; we serve on 8081 for prod parity.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8081"]
