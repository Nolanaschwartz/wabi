"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/admin/research", label: "Research" },
  { href: "/admin/strategies", label: "Strategies" },
];

/**
 * Secondary admin tab strip, rendered beneath the global AppNav for /admin/* routes.
 * Highlights the active route with a copper underline. Presentational only — access
 * control lives in the API proxy / isOperator, not here.
 */
export default function AdminTabs() {
  const pathname = usePathname();

  return (
    <div className="border-b border-ink-2 bg-ink-0">
      <nav className="mx-auto flex max-w-5xl items-center gap-6 px-6">
        {TABS.map((tab) => {
          const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className={`-mb-px border-b-2 py-3 text-sm transition-colors duration-200 ease-calm ${
                active
                  ? "border-copper font-medium text-copper"
                  : "border-transparent text-bone-2 hover:text-bone-0"
              }`}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
