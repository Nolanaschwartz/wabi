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
  effectivenessScore?: number;
  score?: number;
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

  async search(query: string, topK = 3): Promise<StrategyPoint[]> {
    try {
      const embedding = await this.embed(query);
      const results = await this.qdrant.search(COLLECTION_NAME, {
        vector: embedding,
        limit: topK,
        with_payload: true,
      });

      if (results.length === 0) {
        return [];
      }

      return results.map((point: any) => ({
        id: String(point.id),
        content: (point.payload?.content as string) ?? '',
        evidence: (point.payload?.evidence as string) ?? '',
        effectivenessScore: point.payload?.effectivenessScore as number,
        score: point.score as number,
      }));
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
