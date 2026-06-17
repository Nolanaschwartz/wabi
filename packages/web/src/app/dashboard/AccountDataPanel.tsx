'use client';

import { useId, useState } from 'react';

const labelClass = 'font-mono text-[11px] uppercase tracking-[0.14em] text-bone-2';

/**
 * A destructive action behind a type-to-confirm gate. The confirm button stays disabled until the
 * person types the confirmation word, so nothing irreversible fires on a stray click. While the
 * action runs the controls disable and show progress; failure surfaces inline rather than being
 * swallowed. Reused by every destructive action in this tab (delete-my-data, delete-account).
 */
function DangerAction({
  title,
  description,
  confirmWord,
  confirmPrompt,
  actionLabel,
  successMessage,
  onConfirm,
}: {
  title: string;
  description: string;
  confirmWord: string;
  confirmPrompt: string;
  actionLabel: string;
  successMessage: string;
  onConfirm: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const inputId = useId();

  const reset = () => {
    setOpen(false);
    setTyped('');
    setError(null);
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      setDone(true);
    } catch {
      setError('Something went wrong and your request may not have completed. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="rounded-md border border-ink-2 bg-ink-0 p-4">
        <h3 className={labelClass}>{title}</h3>
        <p className="mt-1 text-sm text-sage">{successMessage}</p>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-alert/40 bg-ink-0 p-4">
      <div className="flex items-start justify-between">
        <div className="pr-4">
          <h3 className={labelClass}>{title}</h3>
          <p className="mt-1 text-sm text-bone-1">{description}</p>
        </div>
        {!open && (
          <button
            onClick={() => setOpen(true)}
            className="shrink-0 rounded-md border border-alert/50 bg-ink-2 px-4 py-2 text-sm font-medium text-alert transition-colors duration-200 ease-calm hover:bg-ink-3"
          >
            {actionLabel}
          </button>
        )}
      </div>

      {open && (
        <div className="mt-4 space-y-3">
          <label htmlFor={inputId} className="block text-sm text-bone-1">
            {confirmPrompt} Type <span className="font-mono font-semibold text-bone-0">{confirmWord}</span> to confirm.
          </label>
          <input
            id={inputId}
            type="text"
            autoComplete="off"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            disabled={busy}
            className="w-full rounded-md border border-ink-3 bg-ink-1 px-3 py-2 font-mono text-sm text-bone-0 outline-none focus:border-alert disabled:opacity-50"
          />
          <div className="flex gap-2">
            <button
              onClick={run}
              disabled={busy || typed !== confirmWord}
              className="rounded-md bg-alert px-4 py-2 text-sm font-semibold text-ink-0 transition-colors duration-200 ease-calm hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? 'Working…' : actionLabel}
            </button>
            <button
              onClick={reset}
              disabled={busy}
              className="rounded-md border border-ink-3 bg-ink-2 px-4 py-2 text-sm font-medium text-bone-1 transition-colors duration-200 ease-calm hover:bg-ink-3 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
          {error && <p className="text-sm text-alert">{error}</p>}
        </div>
      )}
    </div>
  );
}

/**
 * The Account & data tab. Each action authenticates the signed-in person via their session and
 * goes through the bot's single data-rights authority (`/api/account/*`). Slice 04 adds
 * delete-my-account here using the same DangerAction gate.
 */
export default function AccountDataPanel() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // POST the export, then download the JSON the server streams back as an attachment.
  const exportData = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/account/export', { method: 'POST' });
      if (!res.ok) {
        setError('Could not export your data. Please try again.');
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'wabi-data-export.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError('Could not export your data. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const deleteData = async () => {
    const res = await fetch('/api/account/delete-data', { method: 'POST' });
    if (!res.ok) throw new Error('delete-data failed');
  };

  const deleteAccount = async () => {
    const res = await fetch('/api/account/delete', { method: 'POST' });
    if (!res.ok) throw new Error('delete-account failed');
    // The account (and session) are gone — leave the dashboard for the public landing page.
    window.location.href = '/';
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between rounded-md border border-ink-2 bg-ink-0 p-4">
        <div className="pr-4">
          <h3 className={labelClass}>Export my data</h3>
          <p className="mt-1 text-sm text-bone-1">
            Download everything Wabi holds about you as a JSON file — your logs and the memory
            it&apos;s formed. Always available.
          </p>
        </div>
        <button
          onClick={exportData}
          disabled={busy}
          className="shrink-0 rounded-md border border-ink-3 bg-ink-2 px-4 py-2 text-sm font-medium text-bone-1 transition-colors duration-200 ease-calm hover:bg-ink-3 disabled:opacity-50"
        >
          {busy ? 'Preparing…' : 'Export'}
        </button>
      </div>

      {error && <p className="text-sm text-alert">{error}</p>}

      <DangerAction
        title="Delete my data"
        description="Permanently erase your logs, journal, tilt history and the memory Wabi has formed. Your account and subscription stay — you keep using Wabi from a clean slate."
        confirmWord="DELETE"
        confirmPrompt="This can't be undone."
        actionLabel="Delete my data"
        successMessage="Your data has been deleted. You're starting fresh."
        onConfirm={deleteData}
      />

      <DangerAction
        title="Delete my account"
        description="Permanently delete your account and everything in it. Your subscription ends immediately with no refund, and your account can't be recovered — you'd start over from scratch if you ever came back."
        confirmWord="DELETE"
        confirmPrompt="This ends your subscription now (no refund) and can't be undone."
        actionLabel="Delete my account"
        successMessage="Your account has been deleted. Take care."
        onConfirm={deleteAccount}
      />
    </div>
  );
}
