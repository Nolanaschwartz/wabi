"""
Wabi self-hosted mem0 REST server.

Drop-in replacement for the route handlers in `mem0/mem0-api-server:latest`, but with an
ENV-DRIVEN config instead of the stock image's hardcoded DEFAULT_CONFIG (pgvector + neo4j +
OpenAI). See ADR-0017 (amended 2026-06-06) and remediation issues #04 / #23 / #37.

Differences from the stock image:
  - Vector store: Qdrant (self-hosted), via host+port (NOT url, since we have no Qdrant api_key).
  - Graph store: OMITTED -> mem0 runs vector-only, no neo4j required.
  - LLM + embedder: OpenAI-compatible, pointed at self-controlled endpoints via env.
      * embedder uses the `lmstudio` provider: it is OpenAI-compatible but does NOT send the
        OpenAI-proprietary `dimensions=` param, which llama.cpp / vLLM embedding servers reject.
  - Same artifact dev->prod; only the *_BASE_URL / *_API_KEY env values change.
"""

import logging
import os
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel, Field

from mem0 import Memory

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")

load_dotenv()

# --- Vector store (Qdrant, self-hosted) ---
QDRANT_HOST = os.environ.get("MEM0_QDRANT_HOST", "qdrant")
QDRANT_PORT = int(os.environ.get("MEM0_QDRANT_PORT", "6333"))
QDRANT_COLLECTION = os.environ.get("MEM0_QDRANT_COLLECTION", "wabi_memories")
EMBEDDING_DIMS = int(os.environ.get("MEM0_EMBEDDING_DIMS", "768"))

# --- LLM (OpenAI-compatible, self-controlled) ---
LLM_BASE_URL = os.environ.get("MEM0_LLM_BASE_URL")
LLM_MODEL = os.environ.get("MEM0_LLM_MODEL", "gpt-4o-mini")
LLM_API_KEY = os.environ.get("MEM0_LLM_API_KEY") or "not-needed"
LLM_TEMPERATURE = float(os.environ.get("MEM0_LLM_TEMPERATURE", "0.2"))

# --- Embedder (OpenAI-compatible via the lmstudio provider; no `dimensions=` param) ---
EMBEDDER_BASE_URL = os.environ.get("MEM0_EMBEDDER_BASE_URL")
EMBEDDER_MODEL = os.environ.get("MEM0_EMBEDDER_MODEL", "nomic-embed-text-v2-moe.Q4_K_M.gguf")
EMBEDDER_API_KEY = os.environ.get("MEM0_EMBEDDER_API_KEY") or "not-needed"

HISTORY_DB_PATH = os.environ.get("HISTORY_DB_PATH", "/app/history/history.db")

DEFAULT_CONFIG = {
    "version": "v1.1",
    "vector_store": {
        "provider": "qdrant",
        "config": {
            "host": QDRANT_HOST,
            "port": QDRANT_PORT,
            "collection_name": QDRANT_COLLECTION,
            "embedding_model_dims": EMBEDDING_DIMS,
        },
    },
    # graph_store intentionally omitted -> enable_graph=False, no neo4j (vector-only, v1).
    "llm": {
        "provider": "openai",
        "config": {
            "model": LLM_MODEL,
            "openai_base_url": LLM_BASE_URL,
            "api_key": LLM_API_KEY,
            "temperature": LLM_TEMPERATURE,
        },
    },
    "embedder": {
        "provider": "lmstudio",
        "config": {
            "model": EMBEDDER_MODEL,
            "lmstudio_base_url": EMBEDDER_BASE_URL,
            "embedding_dims": EMBEDDING_DIMS,
            "api_key": EMBEDDER_API_KEY,
        },
    },
    "history_db_path": HISTORY_DB_PATH,
}

logging.info(
    "Wabi mem0 config: qdrant=%s:%s/%s dims=%s llm=%s@%s embedder=%s@%s (graph disabled)",
    QDRANT_HOST, QDRANT_PORT, QDRANT_COLLECTION, EMBEDDING_DIMS,
    LLM_MODEL, LLM_BASE_URL, EMBEDDER_MODEL, EMBEDDER_BASE_URL,
)

MEMORY_INSTANCE = Memory.from_config(DEFAULT_CONFIG)

app = FastAPI(
    title="Wabi Mem0 REST API",
    description="Self-hosted, vector-only mem0 for Wabi.",
    version="1.0.0",
)


class Message(BaseModel):
    role: str = Field(..., description="Role of the message (user or assistant).")
    content: str = Field(..., description="Message content.")


class MemoryCreate(BaseModel):
    messages: List[Message] = Field(..., description="List of messages to store.")
    user_id: Optional[str] = None
    agent_id: Optional[str] = None
    run_id: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None


class SearchRequest(BaseModel):
    query: str = Field(..., description="Search query.")
    user_id: Optional[str] = None
    run_id: Optional[str] = None
    agent_id: Optional[str] = None
    filters: Optional[Dict[str, Any]] = None


@app.post("/configure", summary="Configure Mem0")
def set_config(config: Dict[str, Any]):
    """Set memory configuration."""
    global MEMORY_INSTANCE
    MEMORY_INSTANCE = Memory.from_config(config)
    return {"message": "Configuration set successfully"}


@app.post("/memories", summary="Create memories")
def add_memory(memory_create: MemoryCreate):
    """Store new memories."""
    if not any([memory_create.user_id, memory_create.agent_id, memory_create.run_id]):
        raise HTTPException(status_code=400, detail="At least one identifier (user_id, agent_id, run_id) is required.")

    params = {k: v for k, v in memory_create.model_dump().items() if v is not None and k != "messages"}
    try:
        response = MEMORY_INSTANCE.add(messages=[m.model_dump() for m in memory_create.messages], **params)
        return JSONResponse(content=response)
    except Exception as e:
        logging.exception("Error in add_memory:")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/memories", summary="Get memories")
def get_all_memories(
    user_id: Optional[str] = None,
    run_id: Optional[str] = None,
    agent_id: Optional[str] = None,
):
    """Retrieve stored memories."""
    if not any([user_id, run_id, agent_id]):
        raise HTTPException(status_code=400, detail="At least one identifier is required.")
    try:
        params = {
            k: v for k, v in {"user_id": user_id, "run_id": run_id, "agent_id": agent_id}.items() if v is not None
        }
        return MEMORY_INSTANCE.get_all(**params)
    except Exception as e:
        logging.exception("Error in get_all_memories:")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/memories/{memory_id}", summary="Get a memory")
def get_memory(memory_id: str):
    """Retrieve a specific memory by ID."""
    try:
        return MEMORY_INSTANCE.get(memory_id)
    except Exception as e:
        logging.exception("Error in get_memory:")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/search", summary="Search memories")
def search_memories(search_req: SearchRequest):
    """Search for memories based on a query."""
    try:
        params = {k: v for k, v in search_req.model_dump().items() if v is not None and k != "query"}
        return MEMORY_INSTANCE.search(query=search_req.query, **params)
    except Exception as e:
        logging.exception("Error in search_memories:")
        raise HTTPException(status_code=500, detail=str(e))


@app.put("/memories/{memory_id}", summary="Update a memory")
def update_memory(memory_id: str, updated_memory: Dict[str, Any]):
    """Update an existing memory with new content."""
    try:
        return MEMORY_INSTANCE.update(memory_id=memory_id, data=updated_memory)
    except Exception as e:
        logging.exception("Error in update_memory:")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/memories/{memory_id}/history", summary="Get memory history")
def memory_history(memory_id: str):
    """Retrieve memory history."""
    try:
        return MEMORY_INSTANCE.history(memory_id=memory_id)
    except Exception as e:
        logging.exception("Error in memory_history:")
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/memories/{memory_id}", summary="Delete a memory")
def delete_memory(memory_id: str):
    """Delete a specific memory by ID."""
    try:
        MEMORY_INSTANCE.delete(memory_id=memory_id)
        return {"message": "Memory deleted successfully"}
    except Exception as e:
        logging.exception("Error in delete_memory:")
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/memories", summary="Delete all memories")
def delete_all_memories(
    user_id: Optional[str] = None,
    run_id: Optional[str] = None,
    agent_id: Optional[str] = None,
):
    """Delete all memories for a given identifier."""
    if not any([user_id, run_id, agent_id]):
        raise HTTPException(status_code=400, detail="At least one identifier is required.")
    try:
        params = {
            k: v for k, v in {"user_id": user_id, "run_id": run_id, "agent_id": agent_id}.items() if v is not None
        }
        MEMORY_INSTANCE.delete_all(**params)
        return {"message": "All relevant memories deleted"}
    except Exception as e:
        logging.exception("Error in delete_all_memories:")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/reset", summary="Reset all memories")
def reset_memory():
    """Completely reset stored memories."""
    try:
        MEMORY_INSTANCE.reset()
        return {"message": "All memories reset"}
    except Exception as e:
        logging.exception("Error in reset_memory:")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/healthz", summary="Liveness probe", include_in_schema=False)
def healthz():
    return {"status": "ok"}


@app.get("/", summary="Redirect to the OpenAPI documentation", include_in_schema=False)
def home():
    return RedirectResponse(url="/docs")
