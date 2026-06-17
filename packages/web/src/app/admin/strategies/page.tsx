'use client';

import { useEffect, useState } from 'react';

interface Strategy {
  id: string;
  title: string;
  technique: string;
  source: string;
  evidence: string;
  sourceText: string | null;
  sourceUrl: string;
  trustLevel: string;
  status: string;
  negativeCount: number;
}

const card = 'rounded-lg border border-ink-3 bg-ink-1 p-6';
const inputCls =
  'min-w-0 flex-1 rounded-md border border-ink-3 bg-ink-2 px-3 py-2 text-sm text-bone-0 placeholder:text-bone-3 transition-colors duration-200 ease-calm focus:border-copper focus:outline-none';
const btnPrimary =
  'rounded-md bg-copper px-4 py-2 text-sm font-semibold text-ink-0 transition-colors duration-200 ease-calm hover:bg-copper-bright disabled:cursor-not-allowed disabled:opacity-50';
const btnSecondary =
  'rounded-md border border-ink-3 bg-ink-2 px-4 py-2 text-sm font-medium text-bone-1 transition-colors duration-200 ease-calm hover:border-ink-4 disabled:cursor-not-allowed disabled:opacity-50';
const btnDanger =
  'rounded-md border border-alert/60 px-4 py-2 text-sm font-medium text-alert transition-colors duration-200 ease-calm hover:bg-alert/10 disabled:cursor-not-allowed disabled:opacity-50';
const metaLabel = 'font-mono text-[11px] uppercase tracking-[0.14em] text-bone-2';

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

  if (loading)
    return (
      <div className="mx-auto max-w-3xl px-6 py-20 font-mono text-sm uppercase tracking-[0.14em] text-bone-2">
        Loading…
      </div>
    );

  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="mb-2 font-display text-3xl font-medium text-bone-0">Strategy review</h1>
      <p className="mb-8 text-sm text-bone-2">
        Research drafts awaiting approval before they enter the shared library.
      </p>

      {strategies.length === 0 ? (
        <div className={card}>
          <p className="text-sm text-bone-2">No pending strategies.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {strategies.map((d) => (
            <div key={d.id} className={card}>
              <h3 className="mb-1 font-display text-xl text-bone-0">{d.title}</h3>
              <p className="mb-3 text-sm text-bone-1">{d.technique}</p>
              <p className={`mb-4 ${metaLabel}`}>
                {d.source} · trust {d.trustLevel}
              </p>

              <label className="mb-4 flex flex-wrap items-center gap-2">
                <span className={metaLabel}>Evidence</span>
                <input
                  value={evidenceDraft[d.id] ?? d.evidence}
                  onChange={(e) =>
                    setEvidenceDraft((prev) => ({ ...prev, [d.id]: e.target.value }))
                  }
                  className={inputCls}
                />
                <button
                  onClick={() => saveEvidence(d.id)}
                  disabled={evidenceDraft[d.id] === undefined || evidenceDraft[d.id] === d.evidence}
                  className={btnSecondary}
                >
                  Save
                </button>
              </label>

              <div className="flex gap-3">
                <button onClick={() => approve(d.id)} className={btnPrimary}>
                  Approve
                </button>
                <button onClick={() => reject(d.id)} className={btnDanger}>
                  Reject
                </button>
              </div>

              <details className="group mt-4 border-t border-ink-2 pt-4">
                <summary className="flex cursor-pointer list-none items-center gap-2 text-sm text-bone-2 transition-colors duration-200 ease-calm hover:text-bone-0 [&::-webkit-details-marker]:hidden">
                  <span
                    aria-hidden
                    className="inline-block transition-transform duration-200 ease-calm group-open:rotate-90"
                  >
                    &#9656;
                  </span>
                  Full text &amp; metadata
                </summary>

                <div className="mt-4 space-y-4">
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
                    <dt className={metaLabel}>Source</dt>
                    <dd className="text-bone-1">{d.source}</dd>
                    <dt className={metaLabel}>Trust</dt>
                    <dd className="text-bone-1">{d.trustLevel}</dd>
                    <dt className={metaLabel}>Status</dt>
                    <dd className="text-bone-1">{d.status}</dd>
                    <dt className={metaLabel}>Negatives</dt>
                    <dd className={d.negativeCount > 0 ? 'text-warn' : 'text-bone-1'}>
                      {d.negativeCount}
                    </dd>
                    <dt className={metaLabel}>Link</dt>
                    <dd>
                      <a
                        href={d.sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="break-all text-copper underline-offset-4 transition-colors duration-200 ease-calm hover:text-copper-bright hover:underline"
                      >
                        {d.sourceUrl}
                      </a>
                    </dd>
                    <dt className={metaLabel}>ID</dt>
                    <dd className="break-all font-mono text-xs text-bone-2">{d.id}</dd>
                  </dl>

                  <div>
                    <p className={`mb-1.5 ${metaLabel}`}>Source text</p>
                    {d.sourceText ? (
                      <p className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-md border border-ink-3 bg-ink-2 p-3 text-sm leading-relaxed text-bone-1">
                        {d.sourceText}
                      </p>
                    ) : (
                      <p className="text-sm text-bone-3">No source text captured.</p>
                    )}
                  </div>
                </div>
              </details>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
