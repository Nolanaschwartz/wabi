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

// Shared Kintsugi class vocabulary (styling only — no behaviour).
const card = 'mb-4 rounded-lg border border-ink-3 bg-ink-1 p-6';
const h2 = 'mb-4 font-display text-xl text-bone-0';
const fieldCls =
  'rounded-md border border-ink-3 bg-ink-2 px-3 py-2 text-sm text-bone-0 transition-colors duration-200 ease-calm focus:border-copper focus:outline-none disabled:cursor-not-allowed disabled:opacity-50';
const btnPrimary =
  'rounded-md bg-copper px-4 py-2 text-sm font-semibold text-ink-0 transition-colors duration-200 ease-calm hover:bg-copper-bright disabled:cursor-not-allowed disabled:opacity-50';
const btnSecondary =
  'rounded-md border border-ink-3 bg-ink-2 px-4 py-2 text-sm font-medium text-bone-1 transition-colors duration-200 ease-calm hover:border-ink-4 disabled:cursor-not-allowed disabled:opacity-50';
const btnDanger =
  'rounded-md border border-alert/60 px-3 py-1.5 text-xs font-medium text-alert transition-colors duration-200 ease-calm hover:bg-alert/10 disabled:cursor-not-allowed disabled:opacity-50';
const checkboxCls = 'h-4 w-4 accent-copper';
const errText = 'text-sm text-alert';
const okText = 'text-sm text-sage';
const metaLabel = 'font-mono text-[11px] uppercase tracking-[0.14em] text-bone-2';

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

  if (loading)
    return (
      <div className="mx-auto max-w-4xl px-6 py-20 font-mono text-sm uppercase tracking-[0.14em] text-bone-2">
        Loading…
      </div>
    );

  return (
    <div className="mx-auto max-w-4xl px-6 py-16">
      <h1 className="mb-2 font-display text-3xl font-medium text-bone-0">Research</h1>
      <p className="mb-8 text-sm text-bone-2">
        Schedule, bounds, and topics for the literature-mining worker.
      </p>

      {error && (
        <p className={`mb-4 ${errText}`}>{error} — the research worker may be offline.</p>
      )}

      <section className={card}>
        <h2 className={h2}>Schedule</h2>

        <label className="mb-3 flex items-center gap-2 text-sm text-bone-1">
          <input
            type="checkbox"
            checked={scheduleEnabled}
            onChange={(e) => {
              setScheduleSaved(false);
              setScheduleEnabled(e.target.checked);
            }}
            aria-label="Enable schedule"
            className={checkboxCls}
          />
          Enable schedule
        </label>

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <select
            value={cadence}
            onChange={(e) => {
              setScheduleSaved(false);
              setCadence(e.target.value as Cadence);
            }}
            aria-label="Cadence"
            disabled={advanced}
            className={fieldCls}
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
            className={fieldCls}
          />

          {cadence === 'weekly' && !advanced && (
            <select
              value={dayOfWeek}
              onChange={(e) => {
                setScheduleSaved(false);
                setDayOfWeek(Number(e.target.value));
              }}
              aria-label="Day of week"
              className={fieldCls}
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
              className={fieldCls}
            >
              {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          )}
        </div>

        <label className="mb-2 flex items-center gap-2 text-[13px] text-bone-2">
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
            className={checkboxCls}
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
            className={`mb-2 w-full font-mono ${fieldCls}`}
          />
        ) : (
          <p className="mb-2 font-mono text-[13px] text-bone-2">Cron: {presetCron}</p>
        )}

        {scheduleError && <p className={`mb-3 ${errText}`}>{scheduleError}</p>}
        {scheduleSaved && <p className={`mb-3 ${okText}`}>Schedule saved.</p>}

        <div className="flex flex-wrap items-center gap-3">
          <button onClick={saveSchedule} disabled={savingSchedule} className={btnPrimary}>
            {savingSchedule ? 'Saving…' : 'Save schedule'}
          </button>

          <button onClick={runNow} disabled={running} className={btnSecondary}>
            {running ? 'Starting…' : 'Run now'}
          </button>

          {runError && <span className={errText}>{runError}</span>}
        </div>
      </section>

      <section className={card}>
        <h2 className={h2}>Bounds</h2>
        {config ? (
          <>
            <div className="mb-4 grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-2">
              {BOUND_LABELS.map(({ key, label }) => (
                <div key={key} className="contents">
                  <label htmlFor={`bound-${key}`} className="text-sm text-bone-1">
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
                    className={`w-36 ${fieldCls}`}
                  />
                </div>
              ))}
            </div>

            {boundsError && <p className={`mb-3 ${errText}`}>{boundsError}</p>}
            {boundsSaved && <p className={`mb-3 ${okText}`}>Bounds saved.</p>}

            <button onClick={saveBounds} disabled={savingBounds} className={btnPrimary}>
              {savingBounds ? 'Saving…' : 'Save bounds'}
            </button>
          </>
        ) : (
          <p className="text-sm text-bone-2">No config loaded.</p>
        )}
      </section>

      <section className={card}>
        <h2 className={h2}>Topics ({topics.length})</h2>

        <div className="mb-3 flex gap-2">
          <input
            type="text"
            value={newTopic}
            onChange={(e) => setNewTopic(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addTopic();
            }}
            placeholder="Add a topic…"
            aria-label="New topic"
            className={`flex-1 ${fieldCls}`}
          />
          <button onClick={addTopic} disabled={busy || !newTopic.trim()} className={btnPrimary}>
            Add
          </button>
        </div>

        {topicError && <p className={`mb-3 ${errText}`}>{topicError}</p>}

        {topics.length === 0 ? (
          <p className="text-sm text-bone-2">No topics seeded.</p>
        ) : (
          <ul className="text-sm">
            {topics.map((t) => (
              <li
                key={t.id}
                className="flex items-center gap-2 border-b border-ink-2 py-2 last:border-b-0"
              >
                <span className={`flex-1 ${t.enabled ? 'text-bone-1' : 'text-bone-3'}`}>
                  {t.text} {t.enabled ? '' : '(disabled)'}
                </span>
                <button
                  onClick={() => toggleTopic(t)}
                  disabled={busy}
                  className="rounded-md border border-ink-3 bg-ink-2 px-3 py-1.5 text-xs font-medium text-bone-1 transition-colors duration-200 ease-calm hover:border-ink-4 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {t.enabled ? 'Disable' : 'Enable'}
                </button>
                <button onClick={() => removeTopic(t.id)} disabled={busy} className={btnDanger}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={card}>
        <h2 className={h2}>Recent runs</h2>

        {runs.length === 0 ? (
          <p className="text-sm text-bone-2">No runs yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px] text-bone-1">
              <thead>
                <tr className={`text-left ${metaLabel}`}>
                  <th className="px-2 py-2 font-normal">Trigger</th>
                  <th className="px-2 py-2 font-normal">Status</th>
                  <th className="px-2 py-2 font-normal">Started</th>
                  <th className="px-2 py-2 text-right font-normal">Submitted</th>
                  <th className="px-2 py-2 text-right font-normal">Deduped</th>
                  <th className="px-2 py-2 text-right font-normal">Rejected</th>
                  <th className="px-2 py-2 text-right font-normal">Errors</th>
                  <th className="px-2 py-2 font-normal">Stop reason</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id} className="border-t border-ink-2">
                    <td className="px-2 py-2">{run.trigger}</td>
                    <td
                      className={`px-2 py-2 ${
                        run.status === 'failed'
                          ? 'text-alert'
                          : run.status === 'success'
                            ? 'text-sage'
                            : 'text-bone-1'
                      }`}
                    >
                      {run.status}
                    </td>
                    <td className="px-2 py-2">
                      {run.startedAt ? new Date(run.startedAt).toLocaleString() : '—'}
                    </td>
                    <td className="px-2 py-2 text-right">{run.submitted}</td>
                    <td className="px-2 py-2 text-right">{run.deduped}</td>
                    <td className="px-2 py-2 text-right">{run.rejected}</td>
                    <td className="px-2 py-2 text-right">{run.errors}</td>
                    <td className="px-2 py-2 text-bone-2">
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
