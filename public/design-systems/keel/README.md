# KEEL — Blueprint Terminal Design System

Design system for **KEEL**: a personal/internal tool that generates the complete
source of truth (SOT) for a fullstack project from a single input — the project
name. Output spans hulu→hilir: constitution, PRD, architecture, API/data
contracts, system prompts (AGENTS.md / CLAUDE.md), and a RAG-ready corpus.

## Brand understanding

KEEL is an engineering instrument, not a toy. The name comes from shipbuilding:
the keel is laid first; every other part of the ship references it. The visual
language borrows from two worlds:

1. **Naval blueprints** — fine grids, hairline strokes, corner ticks, numbered
   sections, drafting-table precision.
2. **Premium terminals** — layered ink backgrounds, monospace artifacts,
   restrained signal-color accents.

The result should feel like reading a living engineering document at night,
drawn by someone who ships.

## Sources consulted

- User intake (2026-08): dark techy, distinctive & bold, personal/internal tool,
  differentiators = RAG corpus generator + drift detection + archetype templates +
  Spec Kit/AGENTS.md export, opinionated stack demo (Next.js 15 · Supabase · Tailwind · Drizzle).
- No pre-existing codebase, Figma file, or brand guidelines existed — this system
  was created from scratch per user instruction.

## Index

| Path | Purpose |
|---|---|
| `tokens/colors_and_type.css` | Canonical color + type tokens (raw → semantic) |
| `SKILL.md` | Portable skill marker; hard rules for applying the system |
| `brand/voice-and-tone.md` | Copy fundamentals |
| `brand/style-notes.md` | Visual foundations: grid, borders, states, motion |

## Status

v0.1 — created alongside the KEEL concept prototype (`opendesign/mockups/keel-concept/`).
Treat as canonical once the prototype direction is confirmed.
