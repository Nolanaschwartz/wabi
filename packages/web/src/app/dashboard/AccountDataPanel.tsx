'use client';

import { useState } from 'react';

const labelClass = 'font-mono text-[11px] uppercase tracking-[0.14em] text-bone-2';

/**
 * The Account & data tab. Each action authenticates the signed-in person via their session and
 * goes through the bot's single data-rights authority (`/api/account/*`). Slice 01 ships Export;
 * delete-my-data and delete-my-account land in later slices.
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
    </div>
  );
}
