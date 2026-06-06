# Wabi is a classic Discord bot with free-form DM coaching and web-first onboarding

Wabi v1 is delivered as a **classic bot** (gateway intents `Guilds`, `DirectMessages`, and the privileged `MessageContent`) that a person reaches in their Discord **DMs** after sharing a single Wabi **hub server**. A free-form DM **is a coaching turn**: the `messageCreate` handler is the primary pipeline, and the `/talk` slash command demotes to an optional in-server entrypoint. Onboarding is **web-first**: the `User` row, explicit LLM-processing consent (`consentAcceptedAt`), and the Trial are all created in the web **Discord OAuth** callback. The DM path is therefore **lookup-only** — it never creates a `User`.

This **amends the delivery mechanism** of ADR-0003 (DM-first stands; "user-installable app, no shared server" does not) and **amends the trial-start trigger** of ADR-0011 (OAuth onboarding, not first DM). DM-first as the *experience*, and inner-state privacy (ADR-0002), are unchanged.

## Considered options

- **User-installable app (`integration_type=1`, interactions only)** — the original ADR-0003 mechanism. Rejected: a user-installed app receives *only* interactions, never a `messageCreate` for DMs. That makes free-form "talk to it like a friend" coaching impossible, removes the message stream the always-on crisis tripwire (ADR-0006) is supposed to screen, and makes Task 13 passive tilt detection unbuildable. You cannot have both "no shared server" and "passively read free-form DMs."
- **Hybrid (user-install slash + classic-bot DM)** — rejected for v1 as two installation/permission models to build and reconcile.
- **Classic bot + hub server (chosen)** — the only model that delivers a real conversational DM companion. Costs: a mutual/hub server is required to open a DM, the `MessageContent` privileged intent must be enabled (and approved by Discord at 100+ servers), and the ADR-0003 invite URL must change from `integration_type=1&scope=applications.commands` to a `scope=bot applications.commands` install.

## Hub-server onboarding (mutual-guild mechanics)

A classic bot can only DM a person it shares a server with, so onboarding must land the person in a single Wabi **hub server**. The person joins via an **explicit invite link** (the post-checkout "Start talking to Wabi" CTA) — Wabi does **not** auto-add them (no `guilds.join` scope; OAuth stays `identify email`), preserving ADR-0003's "never adds anyone to a server."

The hub is **locked down**: regular members have **no viewable channels**, so they see no member-list sidebar and cannot enumerate other members. This neutralizes the otherwise-real leak that "membership in a mental-health bot's server" is socially observable (ADR-0001/0002). The `guildMemberAdd` event on the hub fires the welcome DM (Task 23) and confirms the DM channel works. A stray join *without* prior OAuth still lands safely on the "unconsented DM → setup link" path.

## Consequences

- **Onboarding is web-first; usage is DM-first.** Landing → "Connect Discord" (OAuth) creates the `User`, sets `consentAcceptedAt` and `trialEndsAt`, then the "Start" CTA links the person into the hub server. Only then is a DM productive.
- **The DM pipeline order is fixed:** `tripwire` (pre-consent, safety) → user lookup → consent gate → access gate → `screenForCrisis` classifier → coach + `storeMemory`. An unknown/unconsented DM gets the tripwire plus a "finish setup" link, **never** coaching, and **never** a `User` upsert.
- **`startTrialIfNew` moves to the OAuth route.** The DM path's job becomes "the DM path must never create a `User`," which is a stronger version of the single-entrypoint rule ADR-0011 introduced.
- **`MessageContent` is a launch-gate dependency** (Discord review for a mental-health DM-reading bot) and a privacy surface to disclose in consent (ADR-0009).
- `/talk` is retained only as an in-server affordance; in a DM it is redundant (no ephemeral replies exist in a DM).
