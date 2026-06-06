# Wabi self-hosted mem0: stock image + our env-driven, vector-only config.
# See ADR-0017 (amended) and remediation issues #04 / #23 / #37.
FROM mem0/mem0-api-server:latest

# Override the stock hardcoded-config server with ours.
COPY main.py /app/main.py

EXPOSE 8081

# Stock CMD binds --port 8000 with --reload; we serve on 8081 for prod parity.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8081"]
