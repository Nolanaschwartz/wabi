import { validateRequest } from "@/lib/session";

export default async function Home() {
  const { user } = await validateRequest();
  const loggedIn = Boolean(user);
  const hubInviteUrl = process.env.DISCORD_HUB_INVITE_URL || "#";

  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-8 text-center">
      {/* ambient kintsugi wash */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(80% 90% at 50% -10%, rgba(192,138,78,0.18), transparent 55%), radial-gradient(60% 80% at 12% 8%, rgba(138,154,123,0.10), transparent 60%)",
        }}
      />

      <div className="relative flex flex-col items-center">
        {/* brand mark */}
        <img
          src="/wabi-mark.svg"
          alt="Wabi"
          width={84}
          height={84}
          className="mb-8 rounded-full shadow-glow"
        />

        <h1 className="font-display text-6xl font-medium tracking-tight text-bone-0">
          Wabi
        </h1>
        <p className="mt-4 max-w-md font-display text-2xl italic text-bone-1">
          A mental coach that meets you where you already are.
        </p>

        {loggedIn ? (
          <>
            <a
              href={hubInviteUrl}
              className="mt-10 inline-flex items-center gap-2 rounded-md bg-copper px-6 py-3 text-base font-semibold text-ink-0 transition-colors duration-200 ease-calm hover:bg-copper-bright"
            >
              Start talking to Wabi <span aria-hidden>&rarr;</span>
            </a>
            <form action="/api/auth/logout" method="POST" className="mt-5">
              <button
                type="submit"
                className="text-sm text-bone-2 underline-offset-4 transition-colors hover:text-bone-0 hover:underline"
              >
                log out
              </button>
            </form>
          </>
        ) : (
          <a
            href="/api/auth/discord"
            className="mt-10 inline-flex items-center gap-2 rounded-md bg-discord px-6 py-3 text-base font-semibold text-white transition-colors duration-200 ease-calm hover:bg-discord-dim"
          >
            Connect Discord <span aria-hidden>&rarr;</span>
          </a>
        )}

        <p className="mt-8 font-mono text-[11px] uppercase tracking-[0.16em] text-bone-3">
          private &middot; evidence-grounded &middot; native to discord
        </p>
      </div>
    </main>
  );
}
