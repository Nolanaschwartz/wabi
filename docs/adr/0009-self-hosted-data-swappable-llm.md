# Self-host all data stores; keep the LLM provider swappable, with self-hosting as the destination

Wabi handles mental-health-adjacent conversation, so the privacy goal is to keep personal data on infrastructure we control and to drive the number of external sub-processors toward zero.

## Data stores — self-hosted

Postgres (Records), Mem0 (Memory), Qdrant (Strategies), and Langfuse (traces) are all **self-hosted** (the docker-compose setup). No managed cloud service holds personal data. In particular we use **self-hosted Mem0**, not Mem0 cloud. Langfuse **traces contain full conversation content and are personal data** — they fall under the same delete-my-data path as Records and Memory (ADR-0004), and crisis content is not over-retained.

## Inference — swappable behind an OpenAI-compatible interface

The LLM is a **replaceable component**, not a fixed dependency:

- All inference goes through an **OpenAI-compatible interface** (Vercel AI SDK with a configurable base URL, model, and key). No dependence on OpenAI-proprietary features.
- **OpenAI (GPT-4o) is used for the proof-of-concept only.** The roadmap is to switch to another provider or **self-host an open-source model**, which would remove the last external sub-processor and keep inference on our own infrastructure.
- **Embeddings are also swappable/local.** `embed()` sends user queries and Strategy text to an embedding model — that is the *same* sub-processor concern as chat inference. The embedding provider is configuration (base URL/model), defaults to OpenAI for the PoC, and is on the same path to a local/self-hosted embedding model. Local dev uses a local embedding endpoint.
- **Local development uses a local OpenAI-compatible LLM** — no real user data leaves the machine in dev.

## Interim posture while OpenAI is in the loop

For as long as OpenAI processes real user messages, treat it as a disclosed sub-processor: sign the DPA, prefer Zero Data Retention, and obtain explicit user consent (special-category consent for any EU user under GDPR Article 9). This is interim; the endgame is self-hosted inference.

## Consequences

- Avoid OpenAI-only features; the inference endpoint is configuration (base URL / model / key), not hard-coded.
- "Switch the model" must stay a config change, not a rewrite — this constrains how tightly coaching prompts may couple to a specific model's quirks.
