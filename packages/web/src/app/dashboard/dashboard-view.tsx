'use client';

import { useState } from 'react';

interface BillingState {
  hasActiveAccess: boolean;
  subscriptionStatus: string;
  trialEndsAt: string | null;
}

interface DashboardViewProps {
  user: { discordId: string; email: string | null };
  moods: Array<{ rating: number; emoji: string; createdAt: Date }>;
  playtimes: Array<{ duration: number; createdAt: Date }>;
  streak: number;
  billing: BillingState;
}

const labelClass =
  'font-mono text-[11px] uppercase tracking-[0.14em] text-bone-2';

function BillingPanel({ billing }: { billing: BillingState }) {
  const [busy, setBusy] = useState(false);

  // POST to the billing endpoint and follow the Stripe-hosted URL it returns.
  const go = async (endpoint: '/api/billing/checkout' | '/api/billing/portal') => {
    setBusy(true);
    try {
      const res = await fetch(endpoint, { method: 'POST' });
      if (!res.ok) {
        setBusy(false);
        return;
      }
      const { url } = await res.json();
      if (url) window.location.href = url;
      else setBusy(false);
    } catch {
      setBusy(false);
    }
  };

  const trialMsLeft = billing.trialEndsAt
    ? new Date(billing.trialEndsAt).getTime() - Date.now()
    : 0;
  const trialDaysLeft = Math.max(0, Math.ceil(trialMsLeft / (24 * 60 * 60 * 1000)));

  // Display derived from the shared access state (page.tsx → decideAccess), so a lapsed trial reads
  // "Not subscribed" here exactly when the bot stops coaching.
  const isActive = billing.subscriptionStatus === 'active';
  const inTrial = billing.hasActiveAccess && billing.subscriptionStatus === 'trialing';
  // Anyone with a Stripe subscription (active or past_due) manages it via the portal; everyone else
  // is offered checkout.
  const hasStripeSubscription = isActive || billing.subscriptionStatus === 'past_due';

  return (
    <div className="mb-8 flex items-center justify-between rounded-lg border border-ink-3 bg-ink-1 p-6">
      <div>
        <h2 className={labelClass}>Subscription</h2>
        <p className="mt-2 text-lg font-semibold capitalize text-bone-0">
          {isActive
            ? 'Active'
            : inTrial
              ? `Trial — ${trialDaysLeft} day${trialDaysLeft === 1 ? '' : 's'} left`
              : 'Not subscribed'}
        </p>
      </div>
      {hasStripeSubscription ? (
        <button
          onClick={() => go('/api/billing/portal')}
          disabled={busy}
          className="rounded-md border border-ink-3 bg-ink-2 px-4 py-2 text-sm font-medium text-bone-1 transition-colors duration-200 ease-calm hover:bg-ink-3 disabled:opacity-50"
        >
          {busy ? 'Opening…' : 'Manage billing'}
        </button>
      ) : (
        <button
          onClick={() => go('/api/billing/checkout')}
          disabled={busy}
          className="rounded-md bg-copper px-4 py-2 text-sm font-semibold text-ink-0 transition-colors duration-200 ease-calm hover:bg-copper-bright disabled:opacity-50"
        >
          {busy ? 'Redirecting…' : 'Subscribe'}
        </button>
      )}
    </div>
  );
}

export default function DashboardView({ user, moods, playtimes, streak, billing }: DashboardViewProps) {
  const [activeTab, setActiveTab] = useState<'mood' | 'playtime' | 'streak'>('mood');

  const tab = (id: typeof activeTab, label: string) => (
    <button
      onClick={() => setActiveTab(id)}
      className={`px-4 py-3 text-sm font-medium transition-colors duration-200 ease-calm ${
        activeTab === id
          ? 'border-b-2 border-copper text-copper'
          : 'border-b-2 border-transparent text-bone-2 hover:text-bone-0'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="min-h-screen bg-ink-0 p-8">
      <div className="mx-auto max-w-4xl">
        <div className="mb-8 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src="/wabi-mark.svg" alt="" width={36} height={36} className="rounded-full" />
            <h1 className="font-display text-3xl font-medium text-bone-0">Dashboard</h1>
          </div>
          <form action="/api/auth/logout" method="POST">
            <button
              type="submit"
              className="rounded-md border border-ink-3 bg-ink-1 px-3 py-1.5 text-sm font-medium text-bone-1 transition-colors duration-200 ease-calm hover:bg-ink-2"
            >
              Logout
            </button>
          </form>
        </div>

        <BillingPanel billing={billing} />

        <div className="mb-8 grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="rounded-lg border border-ink-3 bg-ink-1 p-6">
            <h2 className={labelClass}>Streak</h2>
            <p className="mt-2 text-3xl font-bold text-copper-bright">{streak} days</p>
          </div>

          <div className="rounded-lg border border-ink-3 bg-ink-1 p-6">
            <h2 className={labelClass}>Mood entries</h2>
            <p className="mt-2 text-3xl font-bold text-bone-0">{moods.length}</p>
          </div>

          <div className="rounded-lg border border-ink-3 bg-ink-1 p-6">
            <h2 className={labelClass}>Playtime hours</h2>
            <p className="mt-2 text-3xl font-bold text-bone-0">
              {Math.round(playtimes.reduce((acc, p) => acc + p.duration, 0) / 60)}h
            </p>
          </div>
        </div>

        <div className="rounded-lg border border-ink-3 bg-ink-1">
          <div className="border-b border-ink-2">
            <nav className="-mb-px flex">
              {tab('mood', 'Mood history')}
              {tab('playtime', 'Playtime')}
              {tab('streak', 'Streak')}
            </nav>
          </div>

          <div className="p-6">
            {activeTab === 'mood' && (
              <div className="space-y-3">
                {moods.map((mood, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between rounded-md border border-ink-2 bg-ink-0 p-3"
                  >
                    <span className="text-2xl">{mood.emoji}</span>
                    <span className="font-mono text-xs text-bone-2">
                      {new Date(mood.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {activeTab === 'playtime' && (
              <div className="space-y-3">
                {playtimes.map((pt, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between rounded-md border border-ink-2 bg-ink-0 p-3"
                  >
                    <span className="text-sm font-medium text-bone-1">{pt.duration} minutes</span>
                    <span className="font-mono text-xs text-bone-2">
                      {new Date(pt.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {activeTab === 'streak' && (
              <div className="py-10 text-center">
                <p className="font-display text-7xl font-medium text-copper-bright">{streak}</p>
                <p className="mt-2 text-bone-2">day streak — gently held</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
