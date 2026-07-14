# Lion Reader design system — colors & components

The canonical, minimal set of theme colors and components, and the plan to finish
moving the app onto it. The warm-amber accent rationale, with before/after
screenshots across all three themes, is in the exploration PR
([#1172](https://github.com/brendanlong/lion-reader/pull/1172)); those screenshots
and other design assets live on the orphan
[`assets`](https://github.com/brendanlong/lion-reader/tree/assets) branch so they
stay out of `master`'s history.

Principle: **one token per role, themed once.** A component never writes a raw
Tailwind color (`bg-red-50 dark:bg-red-950`); it writes a role (`bg-danger-subtle`),
and the three themes (`:root` / `.dark` / `.epaper` in `src/app/globals.css`) supply
the value. Retheming is editing `globals.css`, never call sites.

Most of this already exists. The status layer (`--danger/--success/--warning/--star`),
neutrals, surfaces, and edges are tokenized and consumed by `StatusCard`, `Alert`,
`Input`, etc. This doc pins down the **target** set (including the amber accent that
hasn't landed yet), flags the few redundant tokens, and lists the remaining work.

## The minimal token set

Grouped by role. "×N themes" values live in `globals.css`; representative light values
shown. A ✅ means it already exists on `master`; ⛽ means it changes in the accent
migration (Phase 1); ➕ means new.

### Neutrals — text (3)

`--text-strong` and `--text-emphasis` were removed and folded into `--text-body`
(issue #1227): near-black titles/unread indicators read as too harsh, so headings
and primary values now share the softer body tone. The e-paper theme keeps its
intentional near-black harshness via its own darker `--text-body` value.

| Token             | Use                                                     |
| ----------------- | ------------------------------------------------------- |
| `--text-body` ✅  | headings, primary values, `<strong>`, body copy, labels |
| `--text-muted` ✅ | secondary text, metadata, hints                         |
| `--text-faint` ✅ | de-emphasized notes, placeholders                       |

### Neutrals — surfaces & edges (5 + 3)

| Token                 | Use                                    |
| --------------------- | -------------------------------------- |
| `--canvas` ✅         | page background behind the shell       |
| `--surface` ✅        | cards, inputs, controls                |
| `--surface-muted` ✅  | chips, skeletons, hover fill           |
| `--surface-subtle` ✅ | note boxes, subtle fills               |
| `--fill-muted` ✅     | tracks, skeleton pulses, thin dividers |
| `--edge` ✅           | card outlines                          |
| `--edge-strong` ✅    | dividers, note-box borders             |
| `--edge-input` ✅     | input/control outlines                 |

### Brand accent — warm amber (6) ⛽

The one interactive/brand hue: links, unread dots, active nav, selection, focus.
Warm ⇒ inherently low-blue-light (works with the extreme-low-blue dark theme); the
`-muted` vivid tone is for fills/dots, the base is the AA-safe tone for link **text**.

| Token                        | Light               | Dark                | E-paper             | Use                              |
| ---------------------------- | ------------------- | ------------------- | ------------------- | -------------------------------- |
| `--accent`                   | amber-700 `#b45309` | amber-400 `#fbbf24` | amber-800 `#92400e` | link text (AA), base interactive |
| `--accent-hover`             | amber-800           | amber-300           | amber-900           | hover                            |
| `--accent-muted`             | amber-500 `#f59e0b` | amber-500           | amber-700           | unread dots, vivid fills         |
| `--accent-subtle`            | amber-50            | amber-900/25        | amber-100           | tint backgrounds                 |
| `--accent-subtle-foreground` | amber-800           | amber-200           | amber-900           | text on subtle                   |
| `--accent-border`            | amber-200           | amber-800           | amber-600           | tinted borders                   |

### Primary (branded CTA) (2) ⛽

Driven off the accent so the main CTA carries the brand instead of reading as "just a
dark button." Needs a saturated fill with AA text: amber-700 + white (light),
amber-400 + zinc-900 (dark), black + white (e-paper).

| Token                        | Use                                                |
| ---------------------------- | -------------------------------------------------- |
| `--primary-solid`            | filled primary button + filled "on"/selected pills |
| `--primary-solid-foreground` | text/icon on the fill                              |

### Focus / selection (2) ⛽ → alias the accent

`--focus` and `--control-selected` become aliases of the accent value (selected
cards/radios/checkboxes and focus rings in brand amber). Kept as named tokens — not
inlined to `--accent` — so the two roles can diverge later, per the existing pattern.

### Info / AI (4) ✅ — deliberately blue, **not** re-hued

Informational alerts and the AI summary card. Kept blue (light) / warm-neutral (dark):
against the amber chrome a blue "assistant" box reads as clearly machine-generated, and
adding a violet "AI" hue would be a needless fourth family. Trim candidates:
`--info-muted`, `--info-foreground` (overlap `--info` / `--info-subtle-foreground`).

| Token                         | Use                              |
| ----------------------------- | -------------------------------- |
| `--info` ✅                   | icon/accent inside info surfaces |
| `--info-subtle` ✅            | info/summary background          |
| `--info-subtle-foreground` ✅ | text on info background          |
| `--info-border` ✅            | info surface border              |

### Status — danger / success / warning (per role: 4 core + 2 filled) ✅

Conventional hues, kept in all themes (a red error is red even in the low-blue dark
theme — the low-blue rule governs dominant surfaces and the accent, not semantics).
The **minimal** per-role set:

| Token (per `{danger,success,warning}`) | Use                                                              |
| -------------------------------------- | ---------------------------------------------------------------- |
| `--{role}`                             | on-surface text/icon (AA on `--surface`)                         |
| `--{role}-subtle`                      | tinted background (alerts, cards)                                |
| `--{role}-subtle-foreground`           | text on the subtle fill                                          |
| `--{role}-border`                      | tinted border                                                    |
| `--{role}-solid` + `-solid-foreground` | filled button/banner/dot (only where a filled affordance exists) |

The landed set also carries `-hover` and `-solid-hover` per role — beyond minimal but
cheap and symmetric; **keep, don't churn.** Audit only for genuinely unused ones
(e.g. `--success-solid-hover`).

### Star (2) ✅

| Token             | Use                                                       |
| ----------------- | --------------------------------------------------------- |
| `--star` ✅       | filled/active star (amber, now same family as the accent) |
| `--star-hover` ✅ | star hover                                                |

### Warning vs. accent — the one deliberate overlap

Both are amber. Accepted because they never share a **treatment**: the accent appears
as link text / dots / focus, warning as an icon + bordered subtle box (`Alert`/
`StatusCard warning`, always with `AlertIcon`). If in-situ review shows ambiguity, the
single lever is nudging `--warning` toward a golder yellow — a one-file change, no call
sites affected. We are **not** fragmenting warning into a separate yellow pre-emptively.

## Components

The primitive set in `src/components/ui/` is complete and mostly correct. Only two
changes are needed; everything else is already token-driven.

| Component                         | State                                                                            | Action                                                                                                                                                                   |
| --------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Button`                          | primary/secondary/ghost; `btn-primary` utility hardcodes raw `zinc` hover/active | **Change:** rework `btn-primary` to derive hover/active from `--primary-solid` (so a branded amber primary works), and **add a `danger` variant** using `--danger-solid` |
| `StatusCard`, `Alert`             | consume `--info/-success/-warning/-danger` tokens                                | ✅ correct                                                                                                                                                               |
| `Input`                           | token border + `--danger` error state                                            | ✅ correct                                                                                                                                                               |
| `Card`, `CardSection`, `NoteBox`  | neutral tokens                                                                   | ✅ correct                                                                                                                                                               |
| `NavLink`                         | neutral tokens; active = `surface-muted`                                         | ✅ correct (active stays neutral, not accent — intentional)                                                                                                              |
| `IconButton`, `StateToggleButton` | raw `zinc` hover remnants                                                        | mop up in Phase 3 (no API change)                                                                                                                                        |
| `TextLink`                        | `text-accent`                                                                    | ✅ correct (re-hues automatically)                                                                                                                                       |
| Star (in `EntryListItem`)         | `text-star`; empty state raw `zinc-300/600`                                      | mop up empty state in Phase 3                                                                                                                                            |

No new components are required. Destructive actions in ~6 files currently hand-roll red
buttons (`UnsubscribeDialog`, `DeleteAccountSettingsContent`, `TagManagement`,
`EmailSettingsContent`, …) — these become `<Button variant="danger">`.

## Migration plan

The heavy lifting (status tokenization #1169, font #1170, density #1171, codemod #1178)
is done. Because everything is tokenized, the visible re-brand is essentially **one
file**.

**Phase 1 — Accent re-hue + branded primary (one PR, the big visible change).**
Edit `globals.css` only: swap `--accent*` to amber in all three themes; repoint
`--focus`, `--control-selected`, and `--primary-solid` to the accent; rewrite the
`btn-primary` utility to drive hover/active/focus from `--primary-solid` instead of raw
zinc. Update the accent comments + `src/components/CLAUDE.md` (light = amber, not blue).
The whole app re-hues from this. Verify: 3-theme screenshots + contrast (link text
amber-700 AA on white; white-on-amber-700 primary AA; dark amber-400).

**Phase 2 — `Button` `danger` variant.** Add the variant; migrate the ~6 hand-rolled
destructive red buttons to it.

**Phase 3 — Finish neutral mop-up.** Codemod the remaining ~172 raw `zinc-*` utilities
to neutral tokens, excluding the documented intentional exceptions (the `active:` press
step; genuine brand chips — Chrome blue, Firefox orange, Discord). Same mechanical
codemod as #1178.

**Phase 4 — Guardrail (keep it consistent forever).** Add a CI check (grep or ESLint
rule) that fails on new raw color utilities (`(text|bg|border|ring)-(zinc|red|green|
amber|blue|…)-\d+`) outside a small allowlist (brand icons, `globals.css`). Without
this, drift returns one PR at a time — this is what makes the cleanup durable.

**Phase 5 — Optional trim.** Drop verified-unused tokens (`--info-muted`,
`--info-foreground`, any unused `-solid-hover`); confirm warning/accent reads OK in
settings notes and pull the yellow lever only if needed.

Phases 1–2 are user-visible and small; 3–4 are mechanical/CI; 5 is cleanup. Each ships
independently.
