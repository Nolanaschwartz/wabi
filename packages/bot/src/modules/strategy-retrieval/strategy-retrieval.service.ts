import { Injectable } from '@nestjs/common';
import { QdrantClient } from '@qdrant/qdrant-js';
import { getProvider } from '@wabi/shared';
import { safeFetch } from '../../lib/safe-fetch';

const COLLECTION_NAME = 'wabi_strategies';
// The personal/strategy embedding dimensionality, in ONE place (also imported by the integration
// test so the two can't drift). Defaults to 768 (local bge/nomic); override via EMBEDDING_DIM when
// the embedding model's output size differs (e.g. a 2048-dim hosted model). Changing this requires
// recreating the qdrant collection, which is sized at creation.
export const VECTOR_SIZE = Number(process.env.EMBEDDING_DIM) || 768;

export interface StrategyPoint {
  id: string;
  content: string;
  evidence: string;
  evidenceTier?: string;
  effectivenessScore?: number;
  score?: number;
}

// Re-rank weights (capture-now consumer of evidenceTier + confidence). Cosine similarity dominates;
// these small bonuses mainly break near-ties toward better-supported strategies. Tunable.
const TIER_BONUS: Record<string, number> = {
  'meta-analysis': 0.05,
  'systematic-review': 0.04,
  rct: 0.03,
  observational: 0.01,
  preprint: 0,
};
const CONFIDENCE_WEIGHT = 0.05;
// Over-fetch factor: pull a wider cosine pool so the re-rank has runners-up to promote.
const RERANK_POOL = 4;

/** Blend cosine similarity with evidence tier + judge confidence. Cosine-dominant by design. */
function rerankScore(p: StrategyPoint): number {
  const cosine = p.score ?? 0;
  const tierBonus = p.evidenceTier ? TIER_BONUS[p.evidenceTier] ?? 0 : 0;
  const confidence = typeof p.effectivenessScore === 'number' ? p.effectivenessScore : 0;
  return cosine + tierBonus + CONFIDENCE_WEIGHT * confidence;
}

@Injectable()
export class StrategyRetrievalService {
  private qdrant: QdrantClient;
  private initialized = false;

  constructor(qdrantUrl?: string) {
    this.qdrant = new QdrantClient({
      url: qdrantUrl || process.env.QDRANT_URL || 'http://localhost:6333',
    });
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    try {
      const collections = await this.qdrant.getCollections();
      const exists = collections.collections.some(
        (c: { name: string }) => c.name === COLLECTION_NAME,
      );
      if (!exists) {
        await this.qdrant.createCollection(COLLECTION_NAME, {
          vectors: {
            size: VECTOR_SIZE,
            distance: 'Cosine',
          },
        });
      }
    } catch {
      // Qdrant unavailable — retrieval will gracefully degrade
    }
    this.initialized = true;
  }

  /** Vector search. `rerank` (default) over-fetches a wider cosine pool and blends tier/confidence so
   * a near-tie can be promoted — the coaching retrieval path. Dedup passes `rerank=false` to get the
   * raw nearest neighbours by cosine: re-ranking + slicing can otherwise evict a true duplicate from
   * the returned window behind lower-cosine, higher-evidence items. */
  async search(query: string, topK = 3, rerank = true): Promise<StrategyPoint[]> {
    try {
      const embedding = await this.embed(query);
      const results = await this.qdrant.search(COLLECTION_NAME, {
        vector: embedding,
        limit: rerank ? Math.max(topK * RERANK_POOL, topK) : topK,
        with_payload: true,
      });

      if (results.length === 0) {
        return [];
      }

      const points: StrategyPoint[] = results.map((point: any) => ({
        id: String(point.id),
        content: (point.payload?.content as string) ?? '',
        evidence: (point.payload?.evidence as string) ?? '',
        evidenceTier: point.payload?.evidenceTier as string | undefined,
        effectivenessScore: point.payload?.effectivenessScore as number,
        score: point.score as number,
      }));

      // Qdrant already returns by cosine desc; only re-rank when asked.
      if (!rerank) return points;
      points.sort((a, b) => rerankScore(b) - rerankScore(a));
      return points.slice(0, topK);
    } catch {
      return [];
    }
  }

  /** Returns whether the point is now in the index. Callers depend on the outcome to keep Postgres
   * status and the Qdrant index in agreement (ADR-0012) — it must NOT swallow failure as success. */
  async upsert(
    id: string,
    content: string,
    evidence: string,
    effectivenessScore?: number,
    evidenceTier?: string,
  ): Promise<boolean> {
    try {
      const embedding = await this.embed(content);
      await this.qdrant.upsert(COLLECTION_NAME, {
        points: [
          {
            id,
            vector: embedding,
            payload: {
              content,
              evidence,
              evidenceTier,
              effectivenessScore,
            },
          },
        ],
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Returns whether the point is now absent from the index (true also if it was never present). */
  async delete(id: string): Promise<boolean> {
    try {
      await this.qdrant.delete(COLLECTION_NAME, { points: [id] });
      return true;
    } catch {
      return false;
    }
  }

  private async embed(text: string): Promise<number[]> {
    // Resolve the embedding provider lazily on every call — never cache env-derived config in a
    // field (the bot starts before inference env vars are populated; see CLAUDE.md).
    const config = getProvider('embedding');
    // OpenAI-compatible embeddings path. The base URL carries no /v1 (see provider.ts), so we append
    // /v1/embeddings here. The Ollama-native /api/embeddings 404s on this server, which made embed()
    // return [] and every approve/upsert silently fail (ADR-0012; 0 points reached Qdrant).
    const data = await safeFetch<{ data?: { embedding?: number[] }[] }>(
      `${config.baseUrl}/v1/embeddings`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Hosted, OpenAI-compatible providers (e.g. OpenRouter) require a Bearer key; a local
          // keyless embedder leaves apiKey empty, in which case we omit the header.
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: config.model,
          input: text,
        }),
      },
      (status) => {
        throw new Error(`Embedding API error: ${status}`);
      },
    );
    return data?.data?.[0]?.embedding ?? [];
  }
}
