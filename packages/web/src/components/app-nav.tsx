import Link from "next/link";
import { validateRequest } from "@/lib/session";

/**
 * Global top navigation. Rendered once in the root layout, so it appears on every
 * page (landing, consent, dashboard, admin). Auth-aware: logged-out users get the
 * Discord connect action; logged-in users get wayfinding + log out. Server
 * component — no client JS; logout is a plain form POST (matching the landing page).
 */
export default async function AppNav() {
  const { user } = await validateRequest();
  const loggedIn = Boolean(user);
  const hubInviteUrl = process.env.DISCORD_HUB_INVITE_URL || "#";

  const linkCls =
    "text-sm text-bone-2 transition-colors duration-200 ease-calm hover:text-bone-0";

  return (
    <header className="sticky top-0 z-20 border-b border-ink-2 bg-ink-0/80 backdrop-blur">
      <nav className="mx-auto flex h-14 max-w-5xl items-center justify-between px-6">
        <Link href="/" className="flex items-center gap-2">
          <img src="/wabi-mark.svg" alt="" width={28} height={28} className="rounded-full" />
          <span className="font-display text-lg font-medium text-bone-0">Wabi</span>
        </Link>

        {loggedIn ? (
          <div className="flex items-center gap-6">
            <Link href="/dashboard" className={linkCls}>
              Dashboard
            </Link>
            <a href={hubInviteUrl} className={linkCls}>
              Talk to Wabi <span aria-hidden>&#8599;</span>
            </a>
            <form action="/api/auth/logout" method="POST">
              <button
                type="submit"
                className="text-sm text-bone-2 underline-offset-4 transition-colors duration-200 ease-calm hover:text-bone-0 hover:underline"
              >
                log out
              </button>
            </form>
          </div>
        ) : (
          <a
            href="/api/auth/discord"
            className="inline-flex items-center gap-2 rounded-md bg-discord px-4 py-2 text-sm font-semibold text-white transition-colors duration-200 ease-calm hover:bg-discord-dim"
          >
            Connect Discord <span aria-hidden>&rarr;</span>
          </a>
        )}
      </nav>
    </header>
  );
}
