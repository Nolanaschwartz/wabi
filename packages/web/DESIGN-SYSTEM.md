# Wabi Design System — web

The **Kintsugi** design system: a dark, warm, evidence-grounded look for Wabi's
web layer. Dark-primary. Warm near-blacks, bone-white type, one oxidized-copper
accent (the "gold seam"), sage for calm and growth.

## How it's wired

- **Tailwind v4**, CSS-first. All tokens live in `src/app/globals.css` under
  `@theme` — there is **no `tailwind.config.js`**. Every token generates a utility
  automatically.
- **Fonts** are loaded with `next/font/google` in `src/app/layout.tsx` and exposed
  as CSS variables (`--font-newsreader`, `--font-hanken`, `--font-jetbrains`),
  which `@theme` maps to `font-display` / `font-sans` / `font-mono`.
- `globals.css` is imported once in `layout.tsx`; `<body>` defaults to
  `bg-ink-0 text-bone-0 font-sans`.

## Tokens → utilities

| Group | Tokens | Example utilities |
|---|---|---|
| Surfaces | `ink-0..4` | `bg-ink-0`, `border-ink-3` |
| Foreground | `bone-0..3` | `text-bone-0`, `text-bone-2` |
| Accent | `copper`, `copper-bright`, `copper-dim` | `bg-copper`, `text-copper`, `hover:bg-copper-bright` |
| Sage | `sage`, `sage-dim` | `text-sage` |
| States | `success`, `warn`, `alert` | `text-warn`, `border-alert` |
| Discord | `discord`, `discord-dim` | `bg-discord` |
| Type | `display`, `sans`, `mono` | `font-display`, `font-mono` |
| Radii | `sm 8`, `md 12`, `lg 16` | `rounded-md`, `rounded-lg` |
| Elevation | `float`, `glow` | `shadow-float`, `shadow-glow` |
| Motion | `calm` | `ease-calm`, `duration-200` |

## Conventions

- **Headings & display** → `font-display` (Newsreader). Body/UI → default `font-sans`
  (Hanken Grotesk). Metadata, labels, indices, timestamps → `font-mono` (JetBrains
  Mono), usually `uppercase tracking-[0.14em] text-bone-2`.
- **One copper action per screen.** Primary buttons `bg-copper text-ink-0
  hover:bg-copper-bright`; secondary `bg-ink-2 border border-ink-3 text-bone-1`.
- **Cards** are barely cards: `rounded-lg border border-ink-3 bg-ink-1 p-6`, no
  shadow. Hover raises the border to `ink-4` if needed.
- **Copper is rare** — links, focus, active tab, the prompt cursor, the single CTA.
  Sage carries "calm / ok / growth"; `alert` is reserved for crisis & safety.
- **No gradients as fills** beyond the soft ambient washes (hero radial). Flat
  surfaces, borders over shadows.
- Streak copy is intentionally gentle ("gently held") — showing up over the number.

## Brand assets (`public/`)

- `wabi-mark.svg` — the new-shoot mark on the warm field (primary avatar/logo)
- `wabi-mark-forest.svg` — cream leaf on a forest field (alt)
- `favicon.ico` / `favicon.svg` / `favicon-16/32.png` / `apple-touch-icon.png` /
  `icon-192/512.png` / `site.webmanifest`

## Coverage

All web surfaces are on the Kintsugi system: the landing, consent, and dashboard
pages, plus the admin tools (`src/app/admin/research/page.tsx` and
`src/app/admin/strategies/page.tsx`). The admin pages share a small inline class
vocabulary (`card`, `btnPrimary`, `btnSecondary`, `btnDanger`, `fieldCls`,
`metaLabel`) defined at the top of each file — reuse those when extending them.
