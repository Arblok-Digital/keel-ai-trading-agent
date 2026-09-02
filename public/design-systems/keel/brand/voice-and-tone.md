# KEEL — Voice & Tone

## Personality
A principal engineer who writes short commit messages and never wastes your
reading time. Confident, precise, slightly nautical when it earns its place.

## Fundamentals

### Casing
- UI copy: **sentence case** ("Generate source of truth", not "Generate Source Of Truth").
- Mono micro-labels: **UPPERCASE** with wide tracking (`01 / ARCHITECTURE`, `STATUS: SYNCED`).
- Product terms lowercase: `system prompt`, `corpus`, `drift`.

### Verbs
Imperative for actions: **Lay the keel**, Generate, Sync, Export.
State verbs over marketing verbs: "SOT generated" not "Your amazing SOT is ready!".

### Punctuation
- No exclamation marks in product UI.
- Em-dash for definitions: "Drift — the SOT no longer matches the code."
- Terminal-style status lines end without periods: `12 artifacts generated`.

### Numbers & code
- Counts in mono: `14 files`, `03 contracts`.
- Versions dotted: `v0.4.1`.
- Timestamps ISO-ish compact: `2026-08-26 14:02`.

### Emoji policy
None. Ever. Icons are SVG line icons at 1.5px stroke if needed; prefer text labels.

## How KEEL talks to users
Direct second person, zero flattery, zero hedging:
- "Type a project name. Get the whole skeleton." 
- "3 artifacts drifted since last sync."
- Not: "Oops! Looks like something went wrong 🙈" → "Generation failed at phase 04. Retry."

## How KEEL talks about itself
Quietly. The product name appears in lowercase logotype contexts (`keel`) and
uppercase display moments (`KEEL`). Tagline in use: **"Lay the keel first."**
Never calls itself "AI-powered", "revolutionary", or "next-generation".
