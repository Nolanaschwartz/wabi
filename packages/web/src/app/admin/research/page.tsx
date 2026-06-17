'use client';

import { useEffect, useState } from 'react';

interface ResearchConfig {
  id: string;
  scheduleCron: string | null;
  scheduleEnabled: boolean;
  maxTopicsPerRun: number;
  maxPapersPerTopic: number;
  maxDiscoverySteps: number;
  maxDraftsPerTopic: number;
  maxDraftsPerRun: number;
  agentTimeoutMs: number;
  runTimeoutMs: number;
  tokenBudget: number;
}

interface ResearchTopic {
  id: string;
  text: string;
  enabled: boolean;
}

interface ConfigResponse {
  config: ResearchConfig | null;
  topics: ResearchTopic[];
}

const BOUND_LABELS: { key: keyof ResearchConfig; label: string }[] = [
  { key: 'maxTopicsPerRun', label: 'Max topics per run' },
  { key: 'maxPapersPerTopic', label: 'Max papers per topic' },
  { key: 'maxDiscoverySteps', label: 'Max discovery steps' },
  { key: 'maxDraftsPerTopic', label: 'Max drafts per topic' },
  { key: 'maxDraftsPerRun', label: 'Max drafts per run' },
  { key: 'agentTimeoutMs', label: 'Agent timeout (ms)' },
  { key: 'runTimeoutMs', label: 'Run timeout (ms)' },
  { key: 'tokenBudget', label: 'Token budget' },
];

export default function ResearchAdminPage() {
  const [config, setConfig] = useState<ResearchConfig | null>(null);
  const [topics, setTopics] = useState<ResearchTopic[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/admin/research/config')
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to load research config (${r.status})`);
        return r.json();
      })
      .then((data: ConfigResponse) => {
        setConfig(data.config ?? null);
        setTopics(Array.isArray(data.topics) ? data.topics : []);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div>Loading...</div>;

  return (
    <div style={{ maxWidth: 800, margin: '2rem auto', padding: '0 1rem', fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ fontSize: '1.5rem', marginBottom: '1rem' }}>Research Admin</h1>

      {error && (
        <p style={{ color: '#dc2626', marginBottom: '1rem' }}>
          {error} — the research worker may be offline.
        </p>
      )}

      <section style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '1rem', marginBottom: '1rem' }}>
        <h2 style={{ fontSize: '1.125rem', margin: '0 0 0.75rem' }}>Schedule</h2>
        <p style={{ margin: 0, fontSize: '0.875rem', color: '#6b7280' }}>
          Enabled: {config?.scheduleEnabled ? 'yes' : 'no'} | Cron: {config?.scheduleCron ?? '(none)'}
        </p>
      </section>

      <section style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '1rem', marginBottom: '1rem' }}>
        <h2 style={{ fontSize: '1.125rem', margin: '0 0 0.75rem' }}>Bounds</h2>
        {config ? (
          <ul style={{ margin: 0, paddingLeft: '1.25rem', fontSize: '0.875rem', color: '#374151' }}>
            {BOUND_LABELS.map(({ key, label }) => (
              <li key={key}>
                {label}: {String(config[key])}
              </li>
            ))}
          </ul>
        ) : (
          <p style={{ margin: 0, fontSize: '0.875rem', color: '#9ca3af' }}>No config loaded.</p>
        )}
      </section>

      <section style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '1rem' }}>
        <h2 style={{ fontSize: '1.125rem', margin: '0 0 0.75rem' }}>Topics ({topics.length})</h2>
        {topics.length === 0 ? (
          <p style={{ margin: 0, fontSize: '0.875rem', color: '#9ca3af' }}>No topics seeded.</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: '1.25rem', fontSize: '0.875rem', color: '#374151' }}>
            {topics.map((t) => (
              <li key={t.id} style={{ color: t.enabled ? '#374151' : '#9ca3af' }}>
                {t.text} {t.enabled ? '' : '(disabled)'}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
