'use client';

import { useRouter } from 'next/navigation';

export default function ConsentPage() {
  const router = useRouter();

  const accept = async () => {
    const res = await fetch('/api/consent/accept', { method: 'POST' });
    if (!res.ok) {
      // Pending-consent cookie missing/expired — restart the OAuth flow.
      router.push('/api/auth/discord');
      return;
    }
    router.push('/dashboard');
  };

  const decline = async () => {
    await fetch('/api/consent/decline', { method: 'POST' });
    router.push('/');
  };

  return (
    <div className="mx-auto max-w-2xl px-6 py-20">
      <div className="mb-8 flex items-center gap-3">
        <img src="/wabi-mark.svg" alt="" width={40} height={40} className="rounded-full" />
        <h1 className="font-display text-3xl font-medium text-bone-0">Before we start</h1>
      </div>

      <div className="mb-8 rounded-lg border border-ink-3 bg-ink-1 p-6">
        <p className="mb-4 font-mono text-[11px] uppercase tracking-[0.14em] text-warn">
          {/* TODO(LEGAL): Replace with final consent wording */}
          Placeholder — pending legal review.
        </p>
        <p className="mb-4 leading-relaxed text-bone-1">
          Wabi processes your messages through an AI provider to generate coaching responses.
          Your conversations are used to personalize your experience and may be stored for
          the duration of your account. We do not sell your data to third parties.
        </p>
        <p className="leading-relaxed text-bone-1">
          By accepting, you consent to this processing. You can revoke consent and request
          data deletion at any time in your account settings.
        </p>
      </div>

      <div className="flex gap-4">
        <button
          onClick={accept}
          className="rounded-md bg-copper px-6 py-3 text-base font-semibold text-ink-0 transition-colors duration-200 ease-calm hover:bg-copper-bright"
        >
          Accept &amp; continue
        </button>
        <button
          onClick={decline}
          className="rounded-md border border-alert px-6 py-3 text-base font-medium text-alert transition-colors duration-200 ease-calm hover:bg-alert/10"
        >
          Decline
        </button>
      </div>
    </div>
  );
}
