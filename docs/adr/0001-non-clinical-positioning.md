# Wabi is a non-clinical wellness companion, not a therapy service

Wabi supports gamers' mental wellbeing (mood, tilt, habits, reflective coaching) but is deliberately **not** a clinical or therapeutic service. We avoid clinical language (therapy, treatment, patient, diagnosis) throughout product copy, prompts, and code in favour of *coaching*, *companion*, and *support*. This caps our implied duty of care and regulatory exposure.

Because the bot still converses with potentially distressed users, it carries a **hard crisis-escalation boundary**: when a user expresses crisis-level distress (e.g. self-harm or suicidal ideation), the AI coach must stop coaching and surface real crisis resources (hotlines) rather than attempt to counsel. This boundary is non-negotiable and overrides all other coaching behaviour.

## Consequences

- The glossary forbids clinical synonyms (see `CONTEXT.md`).
- The AI coach needs a crisis-detection + escalation path before launch; it is a safety requirement, not a feature.
