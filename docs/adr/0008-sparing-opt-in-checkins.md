# Wabi initiates contact sparingly, opt-in, and on the person's terms

Because Wabi is DM-first (ADR-0003), every proactive message lands in the person's private DMs — intimate, and easily experienced as surveillance or spam if mistimed or too frequent. Proactive check-ins are therefore:

- **Opt-in**, with a **user-set cadence** and an easy off switch. Default is *low* (≈ once a day or less). The plan's 4-hour fixed interval (`CHECK_IN_INTERVAL_MS`) is rejected.
- **Quiet-hours / timezone aware** — Wabi never DMs in the middle of someone's night.
- **Triggered by meaningful moments**, not a blind clock — e.g. after a long play session or at a chosen daily reflection time.
- **Frequency-capped**, so contact never feels like monitoring.

## Why

More check-ins raise engagement metrics, so the default growth instinct is to send more. For a wellness companion that lives in someone's DMs, that instinct backfires: it erodes trust, risks Discord flagging the bot for unsolicited DMs, and contradicts ADR-0007 (care over engagement). Recording the principle protects "initiate sparingly, on the person's terms" from being optimised away.
