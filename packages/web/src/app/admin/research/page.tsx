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

interface ResearchRun {
  id: string;
  trigger: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  submitted: number;
  deduped: number;
  rejected: number;
  errors: number;
  stopReason: string | null;
  error: string | null;
}

type Cadence = 'daily' | 'weekly' | 'monthly';

const DOW_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Client-side preset → cron builder, mirroring the server's cron-compile rules (the server's
 * cron-compile is the authoritative validation gate; this is only a convenience). `time` is "HH:MM".
 * Daily → "M H * * *"; Weekly → "M H * * D"; Monthly → "M H D * *".
 */
function buildCron(cadence: Cadence, time: string, dayOfWeek: number, dayOfMonth: number): string {
  const [hh, mm] = time.split(':');
  const h = Number(hh);
  const m = Number(mm);
  if (cadence === 'daily') return `${m} ${h} * * *`;
  if (cadence === 'weekly') return `${m} ${h} * * ${dayOfWeek}`;
  return `${m} ${h} ${dayOfMonth} * *`;
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

  // Schedule panel state.
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [cadence, setCadence] = useState<Cadence>('daily');
  const [time, setTime] = useState('03:00');
  const [dayOfWeek, setDayOfWeek] = useState(1); // Monday
  const [dayOfMonth, setDayOfMonth] = useState(1);
  const [advanced, setAdvanced] = useState(false);
  const [rawCron, setRawCron] = useState('');
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [scheduleSaved, setScheduleSaved] = useState(false);
  const [savingSchedule, setSavingSchedule] = useState(false);

  // Recent-runs panel + Run-now state.
  const [runs, setRuns] = useState<ResearchRun[]>([]);
  const [runError, setRunError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const presetCron = buildCron(cadence, time, dayOfWeek, dayOfMonth);
  const effectiveCron = advanced ? rawCron.trim() : presetCron;

  const saveSchedule = async () => {
    if (savingSchedule) return;
    setScheduleError(null);
    setScheduleSaved(false);
    setSavingSchedule(true);
    try {
      // An enabled schedule needs a cron; a disabled one persists null (keep cadence settings in UI).
      const cron = scheduleEnabled ? effectiveCron : null;
      const r = await fetch('/api/admin/research/schedule', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cron, enabled: scheduleEnabled }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => null);
        const msg =
          (body && (body.message || body.error)) || `Failed to save schedule (${r.status})`;
        throw new Error(Array.isArray(msg) ? msg.join('; ') : String(msg));
      }
      await loadTopics();
      setScheduleSaved(true);
    } catch (e) {
      setScheduleError(e instanceof Error ? e.message : 'Failed to save schedule');
    } finally {
      setSavingSchedule(false);
    }
  };

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
      setScheduleEnabled(data.config.scheduleEnabled);
      if (data.config.scheduleCron) {
        // Persisted cron is the source of truth; surface it in the Advanced field so a reload shows
        // exactly what is scheduled even if it was not built from a preset.
        setAdvanced(true);
        setRawCron(data.config.scheduleCron);
      }
    }
  };

  const loadRuns = async () => {
    const r = await fetch('/api/admin/research/runs?limit=20');
    if (!r.ok) throw new Error(`Failed to load runs (${r.status})`);
    const data = await r.json();
    setRuns(Array.isArray(data) ? data : []);
  };

  // "Run now": enqueue a manual run, then re-fetch the runs list so the new (or collapsed) run shows.
  const runNow = async () => {
    if (running) return;
    setRunError(null);
    setRunning(true);
    try {
      const r = await fetch('/api/admin/research/run', { method: 'POST' });
      if (!r.ok) {
        const body = await r.json().catch(() => null);
        const msg = (body && (body.message || body.error)) || `Failed to start run (${r.status})`;
        throw new Error(Array.isArray(msg) ? msg.join('; ') : String(msg));
      }
      const body = await r.json().catch(() => null);
      // A degraded worker returns { runId: null } — surface that rather than silently doing nothing.
      if (body && body.runId === null) {
        setRunError('Run could not be started — the worker may be offline.');
      }
      await loadRuns();
    } catch (e) {
      setRunError(e instanceof Error ? e.message : 'Failed to start run');
    } finally {
      setRunning(false);
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
    // Run history loads independently so a runs failure never blocks the config screen.
    loadRuns().catch((e) =>
      setRunError(e instanceof Error ? e.message : 'Failed to load runs'),
    );
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

        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem', fontSize: '0.875rem', color: '#374151' }}>
          <input
            type="checkbox"
            checked={scheduleEnabled}
            onChange={(e) => {
              setScheduleSaved(false);
              setScheduleEnabled(e.target.checked);
            }}
            aria-label="Enable schedule"
          />
          Enable schedule
        </label>

        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
          <select
            value={cadence}
            onChange={(e) => {
              setScheduleSaved(false);
              setCadence(e.target.value as Cadence);
            }}
            aria-label="Cadence"
            disabled={advanced}
            style={{ padding: '0.35rem 0.5rem', fontSize: '0.875rem', border: '1px solid #d1d5db', borderRadius: 6 }}
          >
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </select>

          <input
            type="time"
            value={time}
            onChange={(e) => {
              setScheduleSaved(false);
              setTime(e.target.value);
            }}
            aria-label="Time of day"
            disabled={advanced}
            style={{ padding: '0.35rem 0.5rem', fontSize: '0.875rem', border: '1px solid #d1d5db', borderRadius: 6 }}
          />

          {cadence === 'weekly' && !advanced && (
            <select
              value={dayOfWeek}
              onChange={(e) => {
                setScheduleSaved(false);
                setDayOfWeek(Number(e.target.value));
              }}
              aria-label="Day of week"
              style={{ padding: '0.35rem 0.5rem', fontSize: '0.875rem', border: '1px solid #d1d5db', borderRadius: 6 }}
            >
              {DOW_LABELS.map((d, i) => (
                <option key={i} value={i}>{d}</option>
              ))}
            </select>
          )}

          {cadence === 'monthly' && !advanced && (
            <select
              value={dayOfMonth}
              onChange={(e) => {
                setScheduleSaved(false);
                setDayOfMonth(Number(e.target.value));
              }}
              aria-label="Day of month"
              style={{ padding: '0.35rem 0.5rem', fontSize: '0.875rem', border: '1px solid #d1d5db', borderRadius: 6 }}
            >
              {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          )}
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem', fontSize: '0.8125rem', color: '#6b7280' }}>
          <input
            type="checkbox"
            checked={advanced}
            onChange={(e) => {
              setScheduleSaved(false);
              const on = e.target.checked;
              // Switching to Advanced prefills the raw field with the current preset so the operator edits from a known-good cron.
              if (on && rawCron.trim() === '') setRawCron(presetCron);
              setAdvanced(on);
            }}
            aria-label="Advanced raw cron"
          />
          Advanced (raw cron)
        </label>

        {advanced ? (
          <input
            type="text"
            value={rawCron}
            onChange={(e) => {
              setScheduleSaved(false);
              setRawCron(e.target.value);
            }}
            placeholder="M H D M DOW (e.g. 0 3 * * *)"
            aria-label="Raw cron"
            style={{ width: '100%', padding: '0.4rem 0.6rem', fontSize: '0.875rem', fontFamily: 'monospace', border: '1px solid #d1d5db', borderRadius: 6, marginBottom: '0.5rem' }}
          />
        ) : (
          <p style={{ margin: '0 0 0.5rem', fontSize: '0.8125rem', color: '#6b7280', fontFamily: 'monospace' }}>
            Cron: {presetCron}
          </p>
        )}

        {scheduleError && (
          <p style={{ color: '#dc2626', margin: '0 0 0.75rem', fontSize: '0.875rem' }}>{scheduleError}</p>
        )}
        {scheduleSaved && (
          <p style={{ color: '#16a34a', margin: '0 0 0.75rem', fontSize: '0.875rem' }}>Schedule saved.</p>
        )}

        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            onClick={saveSchedule}
            disabled={savingSchedule}
            style={{
              padding: '0.4rem 0.9rem',
              fontSize: '0.875rem',
              border: '1px solid #2563eb',
              borderRadius: 6,
              background: '#2563eb',
              color: '#fff',
              cursor: savingSchedule ? 'not-allowed' : 'pointer',
              opacity: savingSchedule ? 0.6 : 1,
            }}
          >
            {savingSchedule ? 'Saving…' : 'Save schedule'}
          </button>

          <button
            onClick={runNow}
            disabled={running}
            style={{
              padding: '0.4rem 0.9rem',
              fontSize: '0.875rem',
              border: '1px solid #2563eb',
              borderRadius: 6,
              background: '#fff',
              color: '#2563eb',
              cursor: running ? 'not-allowed' : 'pointer',
              opacity: running ? 0.6 : 1,
            }}
          >
            {running ? 'Starting…' : 'Run now'}
          </button>

          {runError && (
            <span style={{ color: '#dc2626', fontSize: '0.875rem' }}>{runError}</span>
          )}
        </div>
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

      <section style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '1rem', marginTop: '1rem' }}>
        <h2 style={{ fontSize: '1.125rem', margin: '0 0 0.75rem' }}>Recent runs</h2>

        {runs.length === 0 ? (
          <p style={{ margin: 0, fontSize: '0.875rem', color: '#9ca3af' }}>No runs yet.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: '0.8125rem',
                color: '#374151',
              }}
            >
              <thead>
                <tr style={{ textAlign: 'left', color: '#6b7280' }}>
                  <th style={{ padding: '0.35rem 0.5rem' }}>Trigger</th>
                  <th style={{ padding: '0.35rem 0.5rem' }}>Status</th>
                  <th style={{ padding: '0.35rem 0.5rem' }}>Started</th>
                  <th style={{ padding: '0.35rem 0.5rem', textAlign: 'right' }}>Submitted</th>
                  <th style={{ padding: '0.35rem 0.5rem', textAlign: 'right' }}>Deduped</th>
                  <th style={{ padding: '0.35rem 0.5rem', textAlign: 'right' }}>Rejected</th>
                  <th style={{ padding: '0.35rem 0.5rem', textAlign: 'right' }}>Errors</th>
                  <th style={{ padding: '0.35rem 0.5rem' }}>Stop reason</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id} style={{ borderTop: '1px solid #f3f4f6' }}>
                    <td style={{ padding: '0.35rem 0.5rem' }}>{run.trigger}</td>
                    <td
                      style={{
                        padding: '0.35rem 0.5rem',
                        color:
                          run.status === 'failed'
                            ? '#dc2626'
                            : run.status === 'success'
                              ? '#16a34a'
                              : '#374151',
                      }}
                    >
                      {run.status}
                    </td>
                    <td style={{ padding: '0.35rem 0.5rem' }}>
                      {run.startedAt ? new Date(run.startedAt).toLocaleString() : '—'}
                    </td>
                    <td style={{ padding: '0.35rem 0.5rem', textAlign: 'right' }}>{run.submitted}</td>
                    <td style={{ padding: '0.35rem 0.5rem', textAlign: 'right' }}>{run.deduped}</td>
                    <td style={{ padding: '0.35rem 0.5rem', textAlign: 'right' }}>{run.rejected}</td>
                    <td style={{ padding: '0.35rem 0.5rem', textAlign: 'right' }}>{run.errors}</td>
                    <td style={{ padding: '0.35rem 0.5rem', color: '#6b7280' }}>
                      {run.error ?? run.stopReason ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
