export type ProviderRole = 'coach' | 'classifier' | 'embedding';

export interface ProviderConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

const providerConfig: Record<ProviderRole, ProviderConfig> = {
  coach: {
    baseUrl: process.env.COACH_BASE_URL || 'https://api.openai.com/v1',
    model: process.env.COACH_MODEL || 'gpt-4o',
    apiKey: process.env.COACH_API_KEY || '',
  },
  classifier: {
    baseUrl: process.env.CLASSIFIER_BASE_URL || 'https://api.openai.com/v1',
    model: process.env.CLASSIFIER_MODEL || 'gpt-4o-mini',
    apiKey: process.env.CLASSIFIER_API_KEY || '',
  },
  embedding: {
    baseUrl: process.env.EMBEDDING_BASE_URL || 'http://localhost:8080',
    model: process.env.EMBEDDING_MODEL || 'bge-base-en-v1.5',
    apiKey: process.env.EMBEDDING_API_KEY || '',
  },
};

export function getProvider(role: ProviderRole): ProviderConfig {
  return providerConfig[role];
}
