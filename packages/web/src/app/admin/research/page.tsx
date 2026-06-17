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
  const [newTopic, setNewTopic] = useState('');
  const [topicError, setTopicError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [bounds, setBounds] = useState<Record<string, string>>({});
  const [boundsError, setBoundsError] = useState<string | null>(null);
  const [boundsSaved, setBoundsSaved] = useState(false);
  const [savingBounds, setSavingBounds] = useState(false);

  const loadTopics = async () => {
    const r = await fetch('/api/admin/research/config');
    if (!r.ok) throw new Error(`Failed to load research config (${r.status})`);
    const data: ConfigResponse = await r.json();
    setConfig(data.config ?? null);
    setTopics(Array.isArray(data.topics) ? data.topics : []);
    if (data.config) {
      setBounds(
        Object.fromEntries(BOUND_LABELS.map(({ key }) => [key, String(data.config![key])])),
      );
    }
  };

  const saveBounds = async () => {
    if (savingBounds) return;
    setBoundsError(null);
    setBoundsSaved(false);
    setSavingBounds(true);
    try {
      const payload: Record<string, number> = {};
      for (const { key } of BOUND_LABELS) payload[key] = Number(bounds[key]);
      const r = await fetch('/api/admin/research/bounds', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => null);
        const msg =
          (body && (body.message || body.error)) || `Failed to save bounds (${r.status})`;
        throw new Error(Array.isArray(msg) ? msg.join('; ') : String(msg));
      }
      await loadTopics();
      setBoundsSaved(true);
    } catch (e) {
      setBoundsError(e instanceof Error ? e.message : 'Failed to save bounds');
    } finally {
      setSavingBounds(false);
    }
  };

  useEffect(() => {
    loadTopics()
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }, []);

  const addTopic = async () => {
    const text = newTopic.trim();
    if (!text || busy) return;
    setTopicError(null);
    setBusy(true);
    try {
      const r = await fetch('/api/admin/research/topics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (r.status === 409) {
        setTopicError(`"${text}" is already a topic.`);
        return;
      }
      if (!r.ok) throw new Error(`Failed to add topic (${r.status})`);
      setNewTopic('');
      await loadTopics();
    } catch (e) {
      setTopicError(e instanceof Error ? e.message : 'Failed to add topic');
    } finally {
      setBusy(false);
    }
  };

  const toggleTopic = async (t: ResearchTopic) => {
    if (busy) return;
    setTopicError(null);
    setBusy(true);
    try {
      const r = await fetch(`/api/admin/research/topics/${t.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !t.enabled }),
      });
      if (!r.ok) throw new Error(`Failed to update topic (${r.status})`);
      setTopics((ts) => ts.map((x) => (x.id === t.id ? { ...x, enabled: !x.enabled } : x)));
    } catch (e) {
      setTopicError(e instanceof Error ? e.message : 'Failed to update topic');
    } finally {
      setBusy(false);
    }
  };

  const removeTopic = async (id: string) => {
    if (busy) return;
    setTopicError(null);
    setBusy(true);
    try {
      const r = await fetch(`/api/admin/research/topics/${id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error(`Failed to remove topic (${r.status})`);
      setTopics((ts) => ts.filter((x) => x.id !== id));
    } catch (e) {
      setTopicError(e instanceof Error ? e.message : 'Failed to remove topic');
    } finally {
      setBusy(false);
    }
  };

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
          <>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr auto',
                gap: '0.5rem 0.75rem',
                alignItems: 'center',
                marginBottom: '0.75rem',
              }}
            >
              {BOUND_LABELS.map(({ key, label }) => (
                <div key={key} style={{ display: 'contents' }}>
                  <label
                    htmlFor={`bound-${key}`}
                    style={{ fontSize: '0.875rem', color: '#374151' }}
                  >
                    {label}
                  </label>
                  <input
                    id={`bound-${key}`}
                    type="number"
                    min={1}
                    value={bounds[key] ?? ''}
                    onChange={(e) => {
                      setBoundsSaved(false);
                      setBounds((b) => ({ ...b, [key]: e.target.value }));
                    }}
                    aria-label={label}
                    style={{
                      width: 140,
                      padding: '0.35rem 0.5rem',
                      fontSize: '0.875rem',
                      border: '1px solid #d1d5db',
                      borderRadius: 6,
                    }}
                  />
                </div>
              ))}
            </div>

            {boundsError && (
              <p style={{ color: '#dc2626', margin: '0 0 0.75rem', fontSize: '0.875rem' }}>
                {boundsError}
              </p>
            )}
            {boundsSaved && (
              <p style={{ color: '#16a34a', margin: '0 0 0.75rem', fontSize: '0.875rem' }}>
                Bounds saved.
              </p>
            )}

            <button
              onClick={saveBounds}
              disabled={savingBounds}
              style={{
                padding: '0.4rem 0.9rem',
                fontSize: '0.875rem',
                border: '1px solid #2563eb',
                borderRadius: 6,
                background: '#2563eb',
                color: '#fff',
                cursor: savingBounds ? 'not-allowed' : 'pointer',
                opacity: savingBounds ? 0.6 : 1,
              }}
            >
              {savingBounds ? 'Saving…' : 'Save bounds'}
            </button>
          </>
        ) : (
          <p style={{ margin: 0, fontSize: '0.875rem', color: '#9ca3af' }}>No config loaded.</p>
        )}
      </section>

      <section style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '1rem' }}>
        <h2 style={{ fontSize: '1.125rem', margin: '0 0 0.75rem' }}>Topics ({topics.length})</h2>

        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem' }}>
          <input
            type="text"
            value={newTopic}
            onChange={(e) => setNewTopic(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addTopic();
            }}
            placeholder="Add a topic…"
            aria-label="New topic"
            style={{
              flex: 1,
              padding: '0.4rem 0.6rem',
              fontSize: '0.875rem',
              border: '1px solid #d1d5db',
              borderRadius: 6,
            }}
          />
          <button
            onClick={addTopic}
            disabled={busy || !newTopic.trim()}
            style={{
              padding: '0.4rem 0.9rem',
              fontSize: '0.875rem',
              border: '1px solid #2563eb',
              borderRadius: 6,
              background: '#2563eb',
              color: '#fff',
              cursor: busy || !newTopic.trim() ? 'not-allowed' : 'pointer',
              opacity: busy || !newTopic.trim() ? 0.6 : 1,
            }}
          >
            Add
          </button>
        </div>

        {topicError && (
          <p style={{ color: '#dc2626', margin: '0 0 0.75rem', fontSize: '0.875rem' }}>{topicError}</p>
        )}

        {topics.length === 0 ? (
          <p style={{ margin: 0, fontSize: '0.875rem', color: '#9ca3af' }}>No topics seeded.</p>
        ) : (
          <ul style={{ margin: 0, padding: 0, listStyle: 'none', fontSize: '0.875rem' }}>
            {topics.map((t) => (
              <li
                key={t.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  padding: '0.35rem 0',
                  borderBottom: '1px solid #f3f4f6',
                }}
              >
                <span style={{ flex: 1, color: t.enabled ? '#374151' : '#9ca3af' }}>
                  {t.text} {t.enabled ? '' : '(disabled)'}
                </span>
                <button
                  onClick={() => toggleTopic(t)}
                  disabled={busy}
                  style={{
                    padding: '0.25rem 0.6rem',
                    fontSize: '0.8125rem',
                    border: '1px solid #d1d5db',
                    borderRadius: 6,
                    background: '#fff',
                    color: '#374151',
                    cursor: busy ? 'not-allowed' : 'pointer',
                  }}
                >
                  {t.enabled ? 'Disable' : 'Enable'}
                </button>
                <button
                  onClick={() => removeTopic(t.id)}
                  disabled={busy}
                  style={{
                    padding: '0.25rem 0.6rem',
                    fontSize: '0.8125rem',
                    border: '1px solid #fca5a5',
                    borderRadius: 6,
                    background: '#fff',
                    color: '#dc2626',
                    cursor: busy ? 'not-allowed' : 'pointer',
                  }}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
