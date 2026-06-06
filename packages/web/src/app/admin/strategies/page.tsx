'use client';

import { useEffect, useState } from 'react';

interface Strategy {
  id: string;
  title: string;
  technique: string;
  source: string;
  evidence: string;
  trustLevel: string;
  status: string;
}

export default function StrategyAdminPage() {
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [loading, setLoading] = useState(true);
  const [evidenceDraft, setEvidenceDraft] = useState<Record<string, string>>({});

  useEffect(() => {
    fetch('/api/admin/strategies/pending')
      .then((r) => r.json())
      .then((data) => setStrategies(Array.isArray(data) ? data : []))
      .finally(() => setLoading(false));
  }, []);

  const approve = async (id: string) => {
    await fetch(`/api/admin/strategies/${id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    setStrategies((s) => s.filter((d) => d.id !== id));
  };

  const reject = async (id: string) => {
    await fetch(`/api/admin/strategies/${id}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    setStrategies((s) => s.filter((d) => d.id !== id));
  };

  const saveEvidence = async (id: string) => {
    const evidence = evidenceDraft[id];
    if (evidence === undefined) return;
    await fetch(`/api/admin/strategies/${id}/evidence`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ evidence }),
    });
    setStrategies((s) => s.map((d) => (d.id === id ? { ...d, evidence } : d)));
    setEvidenceDraft((e) => {
      const next = { ...e };
      delete next[id];
      return next;
    });
  };

  if (loading) return <div>Loading...</div>;

  return (
    <div style={{ maxWidth: 800, margin: '2rem auto', padding: '0 1rem', fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ fontSize: '1.5rem', marginBottom: '1rem' }}>Strategy Admin</h1>
      {strategies.length === 0 ? (
        <p>No pending strategies.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {strategies.map((d) => (
            <div
              key={d.id}
              style={{
                border: '1px solid #e5e7eb',
                borderRadius: 8,
                padding: '1rem',
              }}
            >
              <h3 style={{ margin: '0 0 0.5rem' }}>{d.title}</h3>
              <p style={{ margin: '0 0 0.5rem', fontSize: '0.875rem', color: '#6b7280' }}>
                {d.technique}
              </p>
              <p style={{ margin: '0 0 0.5rem', fontSize: '0.75rem', color: '#9ca3af' }}>
                Source: {d.source} | Trust: {d.trustLevel}
              </p>
              <label
                style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', margin: '0 0 0.75rem', fontSize: '0.75rem', color: '#6b7280' }}
              >
                Evidence:
                <input
                  value={evidenceDraft[d.id] ?? d.evidence}
                  onChange={(e) =>
                    setEvidenceDraft((prev) => ({ ...prev, [d.id]: e.target.value }))
                  }
                  style={{
                    flex: 1,
                    padding: '0.25rem 0.5rem',
                    border: '1px solid #d1d5db',
                    borderRadius: 4,
                    fontSize: '0.75rem',
                  }}
                />
                <button
                  onClick={() => saveEvidence(d.id)}
                  disabled={evidenceDraft[d.id] === undefined || evidenceDraft[d.id] === d.evidence}
                  style={{
                    padding: '0.25rem 0.75rem',
                    background: '#374151',
                    color: 'white',
                    border: 'none',
                    borderRadius: 4,
                    cursor: 'pointer',
                  }}
                >
                  Save
                </button>
              </label>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button
                  onClick={() => approve(d.id)}
                  style={{
                    padding: '0.5rem 1rem',
                    background: '#16a34a',
                    color: 'white',
                    border: 'none',
                    borderRadius: 4,
                    cursor: 'pointer',
                  }}
                >
                  Approve
                </button>
                <button
                  onClick={() => reject(d.id)}
                  style={{
                    padding: '0.5rem 1rem',
                    background: '#dc2626',
                    color: 'white',
                    border: 'none',
                    borderRadius: 4,
                    cursor: 'pointer',
                  }}
                >
                  Reject
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
