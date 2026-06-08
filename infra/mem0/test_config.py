"""
Unit tests for the env-driven mem0 config assembly (ADR-0025 hybrid graph+vector memory).

Pure stdlib (unittest) so it runs without mem0/neo4j/network installed:
    python3 -m unittest discover -s infra/mem0 -p 'test_*.py'

`build_config` lives in config.py with NO `mem0` import, so importing it here is cheap and
side-effect free.
"""

import unittest

from config import build_config

BASE_ENV = {
    "MEM0_QDRANT_HOST": "qdrant",
    "MEM0_QDRANT_PORT": "6333",
    "MEM0_QDRANT_COLLECTION": "wabi_memories",
    "MEM0_EMBEDDING_DIMS": "768",
    "MEM0_LLM_BASE_URL": "http://llm:1234/v1",
    "MEM0_LLM_MODEL": "coach",
    "MEM0_EMBEDDER_BASE_URL": "http://embed:8080/v1",
    "MEM0_EMBEDDER_MODEL": "nomic",
}


class BuildConfigVectorStore(unittest.TestCase):
    def test_vector_store_is_qdrant_from_env(self):
        cfg = build_config(BASE_ENV)
        vs = cfg["vector_store"]
        self.assertEqual(vs["provider"], "qdrant")
        self.assertEqual(vs["config"]["host"], "qdrant")
        self.assertEqual(vs["config"]["port"], 6333)
        self.assertEqual(vs["config"]["collection_name"], "wabi_memories")
        self.assertEqual(vs["config"]["embedding_model_dims"], 768)

    def test_llm_and_embedder_always_present(self):
        cfg = build_config(BASE_ENV)
        self.assertEqual(cfg["llm"]["provider"], "openai")
        self.assertEqual(cfg["llm"]["config"]["model"], "coach")
        self.assertEqual(cfg["embedder"]["provider"], "lmstudio")
        self.assertEqual(cfg["embedder"]["config"]["model"], "nomic")


class BuildConfigGraphStore(unittest.TestCase):
    def test_graph_disabled_when_no_password(self):
        cfg = build_config(BASE_ENV)
        self.assertNotIn("graph_store", cfg)

    def test_graph_enabled_when_password_set(self):
        env = {
            **BASE_ENV,
            "MEM0_GRAPH_URL": "bolt://neo4j:7687",
            "MEM0_GRAPH_USERNAME": "neo4j",
            "MEM0_GRAPH_PASSWORD": "secret",
        }
        cfg = build_config(env)
        gs = cfg["graph_store"]
        self.assertEqual(gs["provider"], "neo4j")
        self.assertEqual(gs["config"]["url"], "bolt://neo4j:7687")
        self.assertEqual(gs["config"]["username"], "neo4j")
        self.assertEqual(gs["config"]["password"], "secret")

    def test_graph_url_and_username_default_when_only_password_set(self):
        env = {**BASE_ENV, "MEM0_GRAPH_PASSWORD": "secret"}
        cfg = build_config(env)
        gs = cfg["graph_store"]
        self.assertEqual(gs["config"]["url"], "bolt://neo4j:7687")
        self.assertEqual(gs["config"]["username"], "neo4j")
        self.assertEqual(gs["config"]["password"], "secret")


if __name__ == "__main__":
    unittest.main()
