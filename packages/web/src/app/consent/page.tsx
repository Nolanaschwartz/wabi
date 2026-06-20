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
          {/* TODO(LEGAL): grounded draft below — accurate to current data flows (ADR-0001/0002/0013/
              0017), but still needs legal sign-off before launch. Keep this banner until then. */}
          Draft — pending legal review. Not final wording.
        </p>
        <p className="mb-4 leading-relaxed text-bone-1">
          Wabi is a non-clinical wellness companion — not a medical, therapy, or crisis service. When
          you message it in your Discord DMs, those messages are sent to an AI provider to generate its
          coaching replies.
        </p>
        <p className="mb-4 leading-relaxed text-bone-1">
          Your verbatim conversations are not stored. Messages are held only briefly to keep the
          conversation going, then deleted; from them Wabi derives short notes about you (for example,
          what you've shared about yourself) so it can stay useful across chats. Anything you log —
          like mood or journal entries — stays private to you and is never shown on a social surface.
        </p>
        <p className="mb-4 leading-relaxed text-bone-1">
          Your data leaves our systems only to the services that run Wabi: Discord, our AI provider,
          and Stripe for billing. We do not sell your data to third parties. If you appear to be in
          crisis, Wabi shows local support resources and does not continue coaching.
        </p>
        <p className="leading-relaxed text-bone-1">
          By accepting, you consent to this processing. You can revoke consent and request a copy or
          deletion of your data at any time in your account settings.
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
