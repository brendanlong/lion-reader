# Components

## Reuse before building

- **Check `src/components/ui/` before creating a primitive** (list it; don't assume one is missing) and `@/components/ui/icons` before adding an inline SVG. Import from the source file (`@/components/ui/button`). Extract a component once a pattern appears three times.
- Keep an icon local only when it needs `suppressHydrationWarning` (it depends on localStorage state) or is a one-off illustration.
- Settings pages use `SettingsSection` (or `SettingsSectionHeading` + `Card`), not a hand-rolled section/card shell.
- `StatusCard`, `Alert` and the `Input` error state are already themed; reuse them rather than building a colored box.
- Shared UI components meet the 44px touch-target minimum; keep it that way.

## Styling

- **Font sizes**: `ui-text-*` classes, never `text-xs`/`text-sm`/….
- **Colors**: semantic tokens only (`text-muted`, `bg-surface`, `border-edge`, `text-danger`, `bg-primary-solid`, …), never a raw light/dark pair. Each role and its value per theme (light, `.dark`, `.epaper`) is defined and commented in `src/app/globals.css`; pick by role there. `pnpm check:colors` (CI) fails on any new raw Tailwind color utility. The few intentional exceptions (press-state `active:` steps, elevation surfaces, brand-colored buttons/chips, `prose-*` modifiers, foreground-on-accent) are in `scripts/raw-color-baseline.json`; add one with `pnpm check:colors --update` only when no token fits the role — never to silence a stray color.
- Don't add a darker title/emphasis text token: headings share `text-body` on purpose (#1227).
- Status hues: `info` blue is informational (and the AI summary card), `danger` red is errors, the amber accent is brand/interactive, `warning` is amber too but always as icon + bordered subtle box, `star` only for the favorite icon. Text on a solid `success`/`warning` fill uses the `-banner` tokens, not `-solid` (which fails AA with white; #1177).
- Active nav rows stay neutral (`bg-surface-muted`), not accent.
- **Focus**: the global `:focus-visible` outline in `globals.css` is the only focus indicator. Never add `focus:ring-*`, `focus:border-*` or `focus:outline-none`, and never put `transition-all` on a focusable element (the outline animates in). An invisible-but-focusable control hides its own chrome, not the element (`opacity-0` hides the outline too; see `ui/drop-zone-file-input.ts`).
- **Themes**: `dark:` doesn't apply to e-paper (`.epaper` is light-like). E-paper carries state on **borders, never fills** (the `globals.css` e-paper comment says why): a control that's borderless in light/dark needs `control-outline`, and anything distinguished by a fill or border color needs a border story there — black edge = active/selected/unread, `border-fill-muted` = passive/read. Use the `epaper:` variant sparingly.

## Screenshots in frontend PRs

Add before/after screenshots when a change affects the UI; for color/theme changes, cover light, dark and e-paper. `/demo` needs no auth (locally under `pnpm dev:local`, or lionreader.com/demo) and the Playwright MCP tools can drive it. For a "before" shot, `git checkout master -- <files>`, screenshot, then `git checkout HEAD -- <files>`. Save shots under the gitignored `.playwright-mcp/`, and host them on the orphan `assets` branch (its README has the plumbing), never on `master` or a feature branch.
