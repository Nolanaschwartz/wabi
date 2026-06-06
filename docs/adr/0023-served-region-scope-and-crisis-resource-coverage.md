# v1 serves US-first; every unserved locale still gets a safe global crisis fallback

Wabi v1 is **US-first**: marketing and onboarding target the US, and Crisis Resources (ADR-0006, Task 30) are vetted for the US plus the main English locales likely to appear (UK, CA, AU, IE). GDPR/EU is **not** actively served in v1 — but the data-rights machinery that makes expansion feasible (consent at OAuth, export/delete, self-hosting) is already built (ADR-0004/0009/0011/0015).

## The hard safety rule (independent of scope)

Region scope **cannot be enforced** — Discord is global and `locale` is self-reported, so some out-of-scope users will always slip in. Therefore the crisis-resource system must **fail safe for any locale**:

- A user whose locale has **vetted** resources gets those.
- **Every other locale** gets a **safe international fallback** — an international helpline directory (e.g. findahelpline.com / Befrienders Worldwide) plus "contact your local emergency services" — **never** a US-only `988`/`741741` shown to a non-US person.

Showing a US-only hotline to someone in crisis abroad is a safety failure, not a cosmetic one. The US fallback is *only* for US (or unknown-but-likely-US) users.

## Why

For a solo-founder PoC, vetting correct hotlines across dozens of countries is an unbounded safety-content burden, and EU Art. 9 compliance is a heavy launch lift. US-first bounds both. But because the served scope is unenforceable, the *fallback* must be globally safe from day one — that is the non-negotiable part. Reach is scoped; safety is not.

## Consequences

- `crisis-resources.json` (Task 30) ships with US + UK/CA/AU/IE entries **and** a mandatory non-US international fallback entry; the escalation action selects by `user.locale` with the international fallback as default, US-`988` never the global default.
- Widening served regions later means: vet more locales' hotlines, add the GDPR paperwork (policy, DPAs, Art. 9), and broaden marketing — the data-subject-rights mechanics already exist.
