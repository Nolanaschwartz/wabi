# @wabi/research

A **standalone research worker** that mines the published literature for evidence-based
wellbeing techniques and submits them to the bot as `StrategyDraft`s for human review. It is
**not** a NestJS module — it is a plain TypeScript program run on a cron/cadence that talks to
the bot over HTTP.

It produces *candidates*, never live strategies: everything it submits lands behind the bot's
strategy quality gate (ADR-0012) and the `/admin/strategies` human-review surface. The worker
never writes to the database directly.

## What it does

```
SEED_TOPICS ─→ for each topic, under a run budget:
  search PubMed + medRxiv ─→ skip already-seen sources (BotClient.seen)
    ─→ relevance gate (LLM)  ─→ extract technique + evidence (LLM)  ─→ in-run dedup
    ─→ BotClient.submit(candidate)  ── POST to the bot's strategy-admin API
  tally outcomes: submitted | deduped | rejected | errors
```

The run core (`runResearch` in `src/run.ts`) is pure and dependency-injected, so the LLM,
sources, and bot client are all mocked in tests. `main()` wires the real implementations.

## Layout (`src/`)

- `run.ts` — entry point + the pure run loop (budget/deadline enforcement, outcome tally).
- `config.ts` — `loadBounds()` (run limits) from env.
- `seed-topics.ts` — the topic list the run iterates.
- `types.ts` — `Paper`, `Candidate`, `Bounds`, `RunSummary`.
- `bot-client.ts` — HTTP client to the bot: `seen(id)` and `submit(candidate)` (maps HTTP
  status → `submitted | deduped | rejected | error`).
- `sources/` — `pubmed.ts` (NCBI E-utilities), `medrxiv.ts` (paginated details API with
  fractional term matching); fixture-backed tests under `__tests__/fixtures/`.
- `agent/` — `relevance-gate.ts`, `extract.ts`, `dedup.ts`, `research-agent.ts`.
- `util/` — `load-env.ts` (loads the root `.env` itself), `logger.ts`, `rate-limiter.ts`.

## Running

```bash
pnpm start                       # ts-node src/run.ts — runs all SEED_TOPICS
pnpm start -- --topic "sleep hygiene"   # single topic
pnpm test                        # jest
pnpm build                       # tsc
```

The worker has no Nest `ConfigModule`, so it **loads the root `.env` itself** via
`loadDotenv()` before resolving any provider — otherwise every LLM call would 401 against the
OpenAI default and silently produce zero candidates (gate fails open, extract returns null,
tokens=0 everywhere). On startup it warns loudly if a role resolved to the OpenAI default with
no key.

## Configuration (env)

Reads the canonical root `.env`. Relevant vars:

- **LLM providers** — `RESEARCH_*` (role `research`) for the extract/main model and
  `RESEARCH_TRIAGE_*` (role `research-triage`, falls back to `CLASSIFIER_*`) for the gate.
- **Bot endpoint** — `BOT_BASE_URL` (default `http://localhost:3001`), `ADMIN_API_SECRET`.
- **Sources** — `NCBI_API_KEY` (PubMed), `RESEARCH_MEDRXIV_MAX_RECORDS` (default 1500),
  `RESEARCH_MEDRXIV_MIN_TERM_FRACTION` (default 0.5).
- **Run bounds** — see `loadBounds()` in `config.ts` (topics/papers/drafts caps, timeouts,
  token budget).

See `../../docs/adr/0012-strategy-quality-gate.md` and `../../docs/ARCHITECTURE.md` for how
submitted drafts flow into review.
