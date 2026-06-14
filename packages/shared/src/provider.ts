export type ProviderRole = 'coach' | 'classifier' | 'embedding' | 'router';

export interface ProviderConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

// Resolved LAZILY, on each call — NOT captured in a module-level const. The bot spawns without the
// inference env vars in process.env; ConfigModule.forRoot loads the root .env later during Nest
// bootstrap, after @wabi/shared is already imported. Reading process.env at import time froze the
// classifier to https://api.openai.com/v1 with an empty key -> 401 -> the classifier's
// fail-to-crisis catch -> a crisis alert on every message. getProvider runs from service
// constructors, which Nest instantiates after ConfigModule has populated process.env.
export function getProvider(role: ProviderRole): ProviderConfig {
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
      model: process.env.EMBEDDING_MODEL || 'nomic-embed-text-v2-moe.Q4_K_M.gguf',
      apiKey: process.env.EMBEDDING_API_KEY || '',
    },
    // Intent router for DM dispatch (which specialised handler answers a free-form DM). A small, fast
    // classify model — separate from the crisis classifier so the two can be tuned/swapped apart. It is
    // never a safety surface: a misconfigured router fails soft to coach (IntentRouterService), so the
    // OpenAI defaults here are harmless if ROUTER_* is unset.
    router: {
      baseUrl: process.env.ROUTER_BASE_URL || 'https://api.openai.com/v1',
      model: process.env.ROUTER_MODEL || 'gpt-4o-mini',
      apiKey: process.env.ROUTER_API_KEY || '',
    },
  };
  return providerConfig[role];
}
