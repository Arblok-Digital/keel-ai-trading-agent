# KEEL — Visual Style Notes

## Backgrounds (layer order, dark only)
1. `--bg-abyss` page canvas, always carrying the blueprint grid (32px, `--grid-line`).
2. `--surface-primary` app chrome (sidebar, topbar).
3. `--surface-panel` content cards/panels.
4. `--surface-raised` elements floating above panels (dropdowns, modals).
5. `--surface-inset` wells for artifact bodies (code, prompts) — darker than its parent.

Grid may intensify to 16px inside inset wells (drafting-paper feel).

## Structure motifs
- **Corner ticks** `+`: place at the four corners of major panels via pseudo-elements or inline SVG, colored `--tick-mark`.
- **Section numbering**: every major zone gets a mono index `01 /`, `02 /`… reset per view.
- **Hairlines before shadows**: separate surfaces with `--border-subtle`; reserve shadows for elevation emergencies only.
- **Dashed connectors**: lineage between SOT sections (constitution → PRD → architecture → contracts → corpus) drawn as dashed 1px vertical lines, amber when a downstream section drifts.

## Color usage rules
- Lime is scarce on purpose. One lime element per view max gets `--glow-lime`.
- Amber appears exactly where review/human attention is required.
- Never tint panels with accent hues; accents live on text, borders, fills ≤ 2px, and small solid chips.

## Type application
| Role | Font | Size token | Notes |
|---|---|---|---|
| Hero display | Clash Display SemiBold/Bold | `--text-d1` | Tight leading (0.95), tracking -1% |
| Section display | Clash Display Medium | `--text-d2` | Paired with mono section index |
| Panel titles | Space Grotesk Medium | `--text-h1..h3` | Sentence case |
| Body/UI | Space Grotesk Regular | `--text-body` | Leading 1.55 |
| Micro-labels | JetBrains Mono Medium | `--label-*` | UPPERCASE, `--label-tracking` |
| Artifacts | JetBrains Mono Regular | `--artifact-*` | Inset wells, syntax-tinted with fg steps only |

## Interactive states
- Hover on rows/buttons: background lifts one layer (`--surface-hover`), 140ms ease-out; optional `--hover-shift` on list rows.
- Pressed accent buttons darken to `--lime-deep`.
- Focus: always visible ring `--focus-ring`; keyboard nav is first-class (this is a dev tool).

## Motion patterns
- **Generation sequence** (signature moment): phases reveal top-down with staggered 60ms delays; running phase shows a scanning hairline sweeping its panel; completed phase's border ticks flash lime once.
- Progress is expressed structurally (phase list states), never as a spinner blob.
- Reduced motion: collapse staggers to instant state changes.

## Iconography
Inline SVG line icons only, 16/20px, stroke 1.5px, currentColor. No icon fonts,
no emoji, no filled duotone sets. If an icon can't be drawn with simple geometry
(square/circle/diamond/line), use a labeled placeholder instead.

## Imagery
None in-product. Marketing surfaces may show artifact screenshots inside inset
wells framed by corner ticks — never stock photos, never 3D blobs.
