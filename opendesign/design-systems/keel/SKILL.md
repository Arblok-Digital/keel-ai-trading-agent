# SKILL: keel-design-system

Apply the KEEL "Blueprint Terminal" design system when building any UI for KEEL —
the source-of-truth generator for fullstack projects (type a project name → get
architecture, system prompts, contracts, and RAG corpus).

## When to use
Any screen, component, marketing surface, or artifact viewer belonging to the KEEL product.

## Canonical tokens
Load `tokens/colors_and_type.css` first. Never hardcode raw values in components —
reference semantic variables (`--surface-panel`, `--border-subtle`, `--artifact-font`…).

## Non-negotiables
1. **Dark native.** Page background is always `--bg-abyss`. Layer upward: deep → base → raised → overlay.
2. **Two accents only.** Keel lime = generation, live, synced, primary action. Drift amber = warnings, drift, human-review gates. Never introduce a third hue except status-error (rusted orange) for failures.
3. **Monospace is the product voice.** All generated artifacts (prompts, architecture docs, contracts) render in `--artifact-font`. UI chrome uses Space Grotesk. Display moments use Clash Display.
4. **Blueprint motifs over decoration.**
   - Fine background grid: `--grid-line`, 32px cells, on page and panel surfaces.
   - Corner ticks (`+`) at panel intersections using `--tick-mark`.
   - Numbered section labels in mono uppercase: `01 / HULU`, `02 / ARCHITECTURE`.
   - Hairline 1px borders everywhere structure is needed; no drop shadows except `--glow-lime` on the single most important live element per view.
5. **Sharp geometry.** Radii: 4–10px. No pill-shaped buttons larger than 999px for chips only. Cards get borders, not shadows.
6. **Motion discipline.** Hover: 140ms ease-out. Reveals during "generation": staggered 60ms steps, 480ms duration, translateY(8px)→0 + opacity. Nothing bounces.
7. **Copy voice**: see `brand/voice-and-tone.md`. Imperative, engineering-log, sentence case; mono micro-labels uppercase.
8. **Forbidden**: bluish-purple gradients, emoji-as-icons, rounded cards with colored left-border strips, Inter/Roboto, decorative stats with no function.

## Type rules
- Display sizes only for hero/section moments; never for body copy.
- Mono micro-labels (`--label-*`) mark every structural boundary.
- Minimum body size 15px; artifact code blocks 13.5px/1.65.

## File map
- `tokens/colors_and_type.css` — canonical tokens
- `brand/voice-and-tone.md` — copy fundamentals
- `brand/style-notes.md` — visual foundations & patterns
