import { QdrantClient } from '@qdrant/qdrant-js';
import { getProvider, type ProviderConfig } from '@wabi/shared';

const COLLECTION_NAME = 'wabi_strategies';
const VECTOR_SIZE = 768;

export interface StrategyPoint {
  id: string;
  content: string;
  evidence: string;
  effectivenessScore?: number;
}

export class StrategyRetrievalService {
  private qdrant: QdrantClient;
  private embeddingConfig: ProviderConfig;
  private initialized = false;

  constructor(qdrantUrl?: string) {
    this.qdrant = new QdrantClient({
      url: qdrantUrl || process.env.QDRANT_URL || 'http://localhost:6333',
    });
    this.embeddingConfig = getProvider('embedding');
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
      }));
    } catch {
      return [];
    }
  }

  async upsert(
    id: string,
    content: string,
    evidence: string,
    effectivenessScore?: number,
  ): Promise<void> {
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
    } catch {
      // Qdrant unavailable — skip silently
    }
  }

  private async embed(text: string): Promise<number[]> {
    const response = await fetch(
      `${this.embeddingConfig.baseUrl}/api/embeddings`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.embeddingConfig.model,
          input: text,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`Embedding API error: ${response.status}`);
    }

    const data = await response.json();
    return data.data?.[0]?.embedding ?? [];
  }
}
