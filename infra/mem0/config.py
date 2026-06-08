"""
Env-driven mem0 config assembly for Wabi's self-hosted mem0 server.

Kept free of any `mem0` import so it can be unit-tested without mem0/neo4j/network installed
(see test_config.py). `main.py` calls `build_config()` and feeds the result to `Memory.from_config`.

Hybrid graph+vector memory (ADR-0025): when `MEM0_GRAPH_PASSWORD` is set, a neo4j `graph_store`
block is added alongside the Qdrant `vector_store`, turning mem0 from vector-only into hybrid.
With no graph password the config stays vector-only (the pre-ADR-0025 behavior), so the same
artifact degrades cleanly in any environment where neo4j is not yet provisioned.
"""

from typing import Any, Dict, Mapping


def build_config(env: Mapping[str, str]) -> Dict[str, Any]:
    """Assemble the mem0 config dict from environment variables.

    Graph memory is enabled iff `MEM0_GRAPH_PASSWORD` is set (url/username have safe defaults).
    """
    config: Dict[str, Any] = {
        "version": "v1.1",
        "vector_store": {
            "provider": "qdrant",
            "config": {
                "host": env.get("MEM0_QDRANT_HOST", "qdrant"),
                "port": int(env.get("MEM0_QDRANT_PORT", "6333")),
                "collection_name": env.get("MEM0_QDRANT_COLLECTION", "wabi_memories"),
                "embedding_model_dims": int(env.get("MEM0_EMBEDDING_DIMS", "768")),
            },
        },
        "llm": {
            "provider": "openai",
            "config": {
                "model": env.get("MEM0_LLM_MODEL", "gpt-4o-mini"),
                "openai_base_url": env.get("MEM0_LLM_BASE_URL"),
                "api_key": env.get("MEM0_LLM_API_KEY") or "not-needed",
                "temperature": float(env.get("MEM0_LLM_TEMPERATURE", "0.2")),
            },
        },
        "embedder": {
            "provider": "lmstudio",
            "config": {
                "model": env.get("MEM0_EMBEDDER_MODEL", "nomic-embed-text-v2-moe.Q4_K_M.gguf"),
                "lmstudio_base_url": env.get("MEM0_EMBEDDER_BASE_URL"),
                "embedding_dims": int(env.get("MEM0_EMBEDDING_DIMS", "768")),
                "api_key": env.get("MEM0_EMBEDDER_API_KEY") or "not-needed",
            },
        },
        "history_db_path": env.get("HISTORY_DB_PATH", "/app/history/history.db"),
    }

    graph_password = env.get("MEM0_GRAPH_PASSWORD")
    if graph_password:
        config["graph_store"] = {
            "provider": "neo4j",
            "config": {
                "url": env.get("MEM0_GRAPH_URL", "bolt://neo4j:7687"),
                "username": env.get("MEM0_GRAPH_USERNAME", "neo4j"),
                "password": graph_password,
            },
        }

    return config
