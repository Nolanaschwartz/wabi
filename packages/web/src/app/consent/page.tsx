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
    <div style={{ maxWidth: 640, margin: '4rem auto', padding: '0 1rem', fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ fontSize: '1.5rem', marginBottom: '1rem' }}>Before we start</h1>

      <div style={{ background: '#f5f5f5', padding: '1.5rem', borderRadius: 8, marginBottom: '1.5rem' }}>
        <p style={{ margin: '0 0 1rem' }}>
          <strong>
            {/* TODO(LEGAL): Replace with final consent wording */}
            PLACEHOLDER — Pending legal review.
          </strong>
        </p>
        <p style={{ margin: '0 0 1rem', lineHeight: 1.6 }}>
          Wabi processes your messages through an AI provider to generate coaching responses.
          Your conversations are used to personalize your experience and may be stored for
          the duration of your account. We do not sell your data to third parties.
        </p>
        <p style={{ margin: 0, lineHeight: 1.6 }}>
          By accepting, you consent to this processing. You can revoke consent and request
          data deletion at any time in your account settings.
        </p>
      </div>

      <div style={{ display: 'flex', gap: '1rem' }}>
        <button
          onClick={accept}
          style={{
            padding: '0.75rem 1.5rem',
            background: '#2563eb',
            color: 'white',
            border: 'none',
            borderRadius: 6,
            cursor: 'pointer',
            fontSize: '1rem',
          }}
        >
          Accept &amp; Continue
        </button>
        <button
          onClick={decline}
          style={{
            padding: '0.75rem 1.5rem',
            background: 'transparent',
            color: '#dc2626',
            border: '1px solid #dc2626',
            borderRadius: 6,
            cursor: 'pointer',
            fontSize: '1rem',
          }}
        >
          Decline
        </button>
      </div>
    </div>
  );
}
