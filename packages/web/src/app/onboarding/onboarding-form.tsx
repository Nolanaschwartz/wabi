'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { IMPROVEMENT_AREAS, INTERESTS } from '@wabi/shared';

/** Humanize an Improvement Area slug into a short checkbox label ("social-connection" → "Social connection"). */
function areaLabel(slug: string): string {
  const words = slug.replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const AREA_SLUGS = Object.keys(IMPROVEMENT_AREAS);
const INTEREST_ENTRIES = Object.entries(INTERESTS) as [string, string][];

type Initial = { locale: string; timezone: string; improveAreas: string[]; interests: string[] };

export default function OnboardingForm({ initial, isEdit }: { initial: Initial; isEdit: boolean }) {
  const router = useRouter();
  const [locale, setLocale] = useState(initial.locale);
  const [timezone, setTimezone] = useState(initial.timezone);
  const [areas, setAreas] = useState<string[]>(initial.improveAreas);
  const [interests, setInterests] = useState<string[]>(initial.interests);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Prefill timezone/locale from the browser on first visit (when the row still holds the
  // UTC/en-US defaults). An editing user keeps whatever they already chose.
  useEffect(() => {
    if (!isEdit) {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz) setTimezone(tz);
      if (navigator.language) setLocale(navigator.language);
    }
  }, [isEdit]);

  const toggle = (list: string[], set: (v: string[]) => void, slug: string) =>
    set(list.includes(slug) ? list.filter((s) => s !== slug) : [...list, slug]);

  const canSubmit = areas.length > 0 && !busy;

  const submit = async () => {
    setBusy(true);
    setError(null);
    const res = await fetch('/api/onboarding', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locale, timezone, improveAreas: areas, interests }),
    });
    if (!res.ok) {
      setBusy(false);
      setError('Pick at least one area you want to work on.');
      return;
    }
    router.push('/dashboard');
  };

  const tzOptions =
    typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [timezone];

  return (
    <div className="mx-auto max-w-2xl px-6 py-20">
      <div className="mb-8 flex items-center gap-3">
        <img src="/wabi-mark.svg" alt="" width={40} height={40} className="rounded-full" />
        <h1 className="font-display text-3xl font-medium text-bone-0">
          {isEdit ? 'Your personalization' : 'Tell Wabi about you'}
        </h1>
      </div>

      <p className="mb-8 leading-relaxed text-bone-1">
        This helps Wabi be useful from your very first message. You can change any of it later.
      </p>

      <section className="mb-8">
        <h2 className="mb-3 font-mono text-[11px] uppercase tracking-[0.14em] text-bone-2">
          What do you want to work on?
        </h2>
        <p className="mb-3 text-sm text-bone-2">Pick at least one.</p>
        <div className="flex flex-wrap gap-2">
          {AREA_SLUGS.map((slug) => {
            const on = areas.includes(slug);
            return (
              <button
                key={slug}
                type="button"
                aria-pressed={on}
                onClick={() => toggle(areas, setAreas, slug)}
                className={`rounded-full border px-4 py-2 text-sm transition-colors duration-200 ease-calm ${
                  on
                    ? 'border-copper bg-copper text-ink-0'
                    : 'border-ink-3 bg-ink-1 text-bone-1 hover:border-copper'
                }`}
              >
                {areaLabel(slug)}
              </button>
            );
          })}
        </div>
      </section>

      <section className="mb-8">
        <h2 className="mb-3 font-mono text-[11px] uppercase tracking-[0.14em] text-bone-2">
          What are you into? <span className="normal-case tracking-normal text-bone-2">(optional)</span>
        </h2>
        <div className="flex flex-wrap gap-2">
          {INTEREST_ENTRIES.map(([slug, label]) => {
            const on = interests.includes(slug);
            return (
              <button
                key={slug}
                type="button"
                aria-pressed={on}
                onClick={() => toggle(interests, setInterests, slug)}
                className={`rounded-full border px-4 py-2 text-sm transition-colors duration-200 ease-calm ${
                  on
                    ? 'border-copper bg-copper text-ink-0'
                    : 'border-ink-3 bg-ink-1 text-bone-1 hover:border-copper'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      </section>

      <section className="mb-10 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm text-bone-1">
          Time zone
          <select
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            className="rounded-md border border-ink-3 bg-ink-1 px-3 py-2 text-bone-0"
          >
            {tzOptions.includes(timezone) ? null : <option value={timezone}>{timezone}</option>}
            {tzOptions.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm text-bone-1">
          Language
          <input
            value={locale}
            onChange={(e) => setLocale(e.target.value)}
            className="rounded-md border border-ink-3 bg-ink-1 px-3 py-2 text-bone-0"
          />
        </label>
      </section>

      {error && <p className="mb-4 text-sm text-alert">{error}</p>}

      <button
        onClick={submit}
        disabled={!canSubmit}
        className="rounded-md bg-copper px-6 py-3 text-base font-semibold text-ink-0 transition-colors duration-200 ease-calm hover:bg-copper-bright disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? 'Saving…' : isEdit ? 'Save changes' : 'Finish setup'}
      </button>
    </div>
  );
}
