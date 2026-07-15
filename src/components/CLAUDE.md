# Components

This file governs the React components in `src/components/`. Data-flow diagram: `docs/diagrams/frontend-data-flow.d2`. Cache/query contract: `src/FRONTEND_STATE.md`.

## UI Components

Reusable UI primitives are in `src/components/ui/`. **Always check for existing components before creating new ones.** Import directly from source files, e.g. `import { Button } from "@/components/ui/button";`

### Available Components

| Component             | Purpose                                                       |
| --------------------- | ------------------------------------------------------------- |
| **Button**            | Primary, secondary, ghost, danger variants with loading state |
| **Input**             | Text input with label and error handling                      |
| **Alert**             | Status messages (error, success, warning, info)               |
| **Dialog**            | Modal dialogs with backdrop, focus trap, escape handling      |
| **Card**              | Container with border, background, and consistent padding     |
| **CardSection**       | Subsection within a Card, separated by a top border           |
| **NoteBox**           | Subtle zinc-tinted box for notes and secondary content        |
| **StatusCard**        | Colored card for info/success/warning/error states            |
| **ClientLink**        | Internal navigation links (use instead of Next.js Link)       |
| **TextLink**          | Accent-colored inline text link (`external` for new tab)      |
| **InlineCode**        | Small monospace chip for inline code, URLs, file names        |
| **Kbd**               | Keyboard key chip for displaying shortcut keys                |
| **NavLink**           | Sidebar navigation links with active state and counts         |
| **IconButton**        | Small icon-only action buttons (edit, close, etc.)            |
| **NotFoundCard**      | Card for 404/missing content states                           |
| **ColorPicker**       | Color selection with `ColorDot` preview                       |
| **StateToggleButton** | Toggle button with visual state indicator                     |

### Common Icons

Icons are in `@/components/ui/icon-button`. Use these instead of duplicating SVGs:

- **Navigation**: `CloseIcon`, `ChevronDownIcon`, `ChevronUpIcon`, `ChevronLeftIcon`, `ChevronRightIcon`, `ArrowLeftIcon`
- **Actions**: `EditIcon`, `TrashIcon`, `CheckIcon`, `PlusIcon`
- **Status**: `StarIcon`, `StarFilledIcon`, `CircleIcon`, `CircleFilledIcon`, `AlertIcon`, `SparklesIcon`
- **Media**: `PlayIcon`, `PauseIcon`, `SkipBackwardIcon`, `SkipForwardIcon`, `NarrationIcon`
- **Visibility**: `EyeIcon`, `EyeSlashIcon`
- **Files**: `UploadIcon`, `DownloadIcon`, `ExternalLinkIcon`, `DocumentIcon`
- **Sort**: `SortDescendingIcon`, `SortAscendingIcon`
- **Empty state**: `DefaultEmptyIcon`
- **Brand**: `GoogleIcon`, `AppleIcon`, `DiscordIcon`, `ChromeIcon`, `FirefoxIcon`
- **Network**: `WifiOffIcon`, `WifiOnIcon`
- **Loading**: `SpinnerIcon` (animated)

### Text Sizing

**Always use `ui-text-*` classes instead of `text-*` for font sizing.** These custom classes ensure consistent sizing across the app:

- `ui-text-xs` - Extra small text
- `ui-text-sm` - Small text (most common)
- `ui-text-base` - Base/body text
- `ui-text-lg` - Large text (headings)

The `ui-text-*` classes are defined in `src/app/globals.css` and provide responsive scaling.

### Semantic Colors

**Use the semantic color tokens instead of raw zinc light/dark pairs.** Each token is one utility class covering all themes; the palettes live in `src/app/globals.css` (`:root` for light, `.dark`, and `.epaper` for e-ink screens), so retheming means editing CSS variables, not call sites:

| Token                | Replaces                               | Use for                                                                         |
| -------------------- | -------------------------------------- | ------------------------------------------------------------------------------- |
| `text-body`          | `text-zinc-700 dark:text-zinc-300`     | Headings, primary values, `<strong>`, body copy, labels                         |
| `text-muted`         | `text-zinc-600 dark:text-zinc-400`     | Descriptions, secondary text, metadata, hints                                   |
| `text-faint`         | `text-zinc-400 dark:text-zinc-500`     | De-emphasized notes, placeholders                                               |
| `bg-canvas`          | `bg-zinc-50 dark:bg-zinc-950`          | Page background behind the shell                                                |
| `bg-surface`         | `bg-white dark:bg-zinc-900`            | Cards, inputs, controls                                                         |
| `bg-surface-muted`   | `bg-zinc-100 dark:bg-zinc-800`         | Chips, skeletons, and hover fill (`hover:bg-surface-muted`) on controls/rows    |
| `bg-surface-subtle`  | `bg-zinc-50 dark:bg-zinc-800/50`       | Note boxes, subtle fills                                                        |
| `bg-fill-muted`      | `bg-zinc-200 dark:bg-zinc-700`         | Skeleton pulses, toggle-off/progress/range tracks, thin dividers                |
| `border-edge`        | `border-zinc-200 dark:border-zinc-800` | Card outlines (also `divide-edge`)                                              |
| `border-edge-strong` | `border-zinc-200 dark:border-zinc-700` | Dividers, note-box borders                                                      |
| `border-edge-input`  | `border-zinc-300 dark:border-zinc-700` | Input/control outlines                                                          |
| `ring-focus`         | accent (amber-700 / amber-400)         | Focus rings (as `focus:ring-focus`); also `focus:border-focus`                  |
| `control-selected`   | accent (amber-700 / amber-400)         | Selected/"on" outline: checkbox/radio/selected-card `border`/`ring`, radio dots |

#### Status colors (danger / success / warning / info / star)

**Never hand-roll a raw `red/green/amber/yellow` pair for a status.** Each status role is tokenized the same way as the neutrals — one utility class per role, covering light, dark, and e-paper — themed in `globals.css` and exposed via `@theme inline`. Dark mode keeps status hues conventional (a red error stays red); e-paper darkens each so it survives grayscale. The base on-surface text and `-subtle-foreground` tokens meet WCAG AA on their backgrounds in all three themes (this is why success text is `green-700`, not the AA-failing `green-600`).

| Token role                      | Danger (red)                    | Success (green)                   | Warning (amber)                   | Use for                                                   |
| ------------------------------- | ------------------------------- | --------------------------------- | --------------------------------- | --------------------------------------------------------- |
| `text-{role}`                   | `text-danger`                   | `text-success`                    | `text-warning`                    | Status text/icon on a normal surface (AA)                 |
| `text-{role}-hover`             | `text-danger-hover`             | `text-success-hover`              | `text-warning-hover`              | `hover:`/link hover for status text                       |
| `bg-{role}-subtle`              | `bg-danger-subtle`              | `bg-success-subtle`               | `bg-warning-subtle`               | Subtle status card/alert/badge fill (also `hover:` fills) |
| `text-{role}-subtle-foreground` | `text-danger-subtle-foreground` | `text-success-subtle-foreground`  | `text-warning-subtle-foreground`  | Text on a `-subtle` fill (AA)                             |
| `border-{role}-border`          | `border-danger-border`          | `border-success-border`           | `border-warning-border`           | Border of a subtle status card/alert                      |
| `bg-{role}-solid` (+ `-hover`)  | `bg-danger-solid`               | `bg-success-solid`                | `bg-warning-solid`                | Solid status button/**dot**; hover via `-solid-hover`     |
| `text-{role}-solid-foreground`  | `text-danger-solid-foreground`  | `text-success-solid-foreground`   | `text-warning-solid-foreground`   | Text/icon on a `-solid` fill                              |
| `bg-{role}-banner`              | —                               | `bg-success-banner`               | `bg-warning-banner`               | Solid banner with **text** (AA white-on-color)            |
| `text-{role}-banner-foreground` | —                               | `text-success-banner-foreground`  | `text-warning-banner-foreground`  | Text/icon on a `-banner` fill (AA)                        |
| `border-{role}` / `ring-{role}` | `border-danger` / `ring-danger` | `border-success` / `ring-success` | `border-warning` / `ring-warning` | Input-error border + focus ring                           |

- **`info`** is the pre-existing blue trio (`text-info-foreground`, `bg-info-subtle`, `border-info-border`, `text-info-subtle-foreground`, …) — unchanged. Use it for genuinely informational (not brand) blue: the `WebSub`/websub-active badges, the invite `pending` badge, the "info" `SummaryCard` variant, and the Google-Docs lock icon are all `info`, not raw blue/purple. Links use `text-accent hover:text-accent-hover` like every other link. The accent is the warm **amber** brand hue in every theme (amber-700 light / amber-400 dark / amber-800 e-paper) — warm ⇒ low-blue-light, and deliberately kept distinct from `info` blue (informational) and `danger` red (error): amber = brand/interactive, blue = informational, red = error.
- **`star`**: `text-star` (+ `hover:text-star-hover`, `bg-star`) is the formalized amber favorite/star color. Use it only for the star/favorite icon; amber used for alerts/offline/"unsaved changes" is `warning`, not `star`.
- **`-solid` vs `-banner`**: `warning`/`success` `-solid` fills (amber-500 / green-600) are deliberately **bright** so an icon or status dot reads as an affordance, but white text on them fails WCAG AA. For a solid bar/button that carries **text** with a white foreground, use `bg-{role}-banner` + `text-{role}-banner-foreground` (amber-700 / green-700 — AA at ~5:1 in all themes), not `-solid` (issue #1177). `danger-solid` (red-600) already passes AA with white, so there's no `danger-banner`.
- `StatusCard`, `Alert`, and the `Input` error state are already token-driven — reuse them instead of rebuilding a colored box.

**Global focus outline.** Every focusable element gets an amber `:focus-visible` outline by default via a single `@layer base` rule in `globals.css` (`outline: 2px solid var(--focus)`), so bare focusable elements (nav links, entry rows, plain links) are already covered and no longer fall back to the browser-default blue outline. Add `focus:ring-focus` only for controls that want a box-shadow ring instead (buttons, inputs) — those pair it with `focus:outline-none`, which wins from the utilities layer and suppresses the global outline so there's no double indicator. Don't set `focus:outline-none` without also adding a ring, or the element ends up with no focus indicator at all.

Tokens work under variants (`hover:bg-surface-muted`, `focus:ring-focus`), so interactive states use them too. Notes:

- **Filled** "on"/selected controls (a solid pill/toggle, not an outline) use `bg-primary-solid text-primary-solid-foreground` — the same token as primary buttons (now the branded amber fill). `control-selected` is the **outline/indicator** color for the same states; it aliases the accent (amber) and shares `ring-focus`'s value today, but is a separate token so the two roles can diverge.
- The `active:` press step (`active:bg-zinc-100 dark:active:bg-zinc-700`) is deliberately left raw — it's the pressed state, one step darker than the `surface-muted` hover.
- **Allow-listed raw `zinc`/brand utilities** (grep `zinc-` is otherwise ~zero in `src/components` + `src/app`; issue #1178). These have **no exact token** — don't force-fit them, and don't count them as "un-migrated": (1) the `active:` press step above; (2) `prose-*` typography modifiers and the raw CSS hex in `NarrationHighlightStyles`; (3) **brand / high-contrast controls** — the Discord blurple button (`indigo-*`), the **Chrome-blue** and **Firefox-orange** browser-extension chips (`BookmarkletSettings`; each is the browser's own brand color, so they stay raw `blue-*`/`orange-*` rather than mapping to `info`/`warning` — `info` even grays out in dark mode), the black/white Apple-style OAuth button, and the bespoke copy-chip surfaces; (4) **elevation surfaces** intentionally one shade lighter than `bg-surface` (popovers, inner stat cards, selected radio-cards: `bg-white`/`bg-zinc-50 dark:bg-zinc-800`), form-control dark bg fills (`dark:bg-zinc-800` on checkboxes), translucent overlays (`bg-white/95 dark:bg-zinc-900/95`), and the mid-emphasis selection/dropzone borders (`border-zinc-400 dark:border-zinc-500`); (5) foreground-on-accent text (`text-white dark:text-zinc-900`). Add a token only if a case becomes a genuine recurring role — don't invent drift. Interaction states (`hover:`/`focus:`) and de-emphasized text **do** use the adjacent token (`hover:text-body`, `text-faint`, `focus:ring-offset-surface`, …).
- **Guardrail (`pnpm check:colors`, CI-enforced).** A ratchet script (`scripts/check-raw-colors.mjs`) fails CI on any **new** raw Tailwind color utility (`text-blue-500`, `bg-zinc-700`, …) in `src/**/*.{ts,tsx}` — use a semantic token instead. The current intentional exceptions above are snapshotted in `scripts/raw-color-baseline.json`; only `(file, utility)` pairs not in that baseline fail. When you add a **genuinely** intentional exception, run `pnpm check:colors --update` and commit the baseline diff (it's reviewed like any change) — don't reach for `--update` to silence a stray color you should have tokenized. This catches raw color **classes**, not the absence of a property (e.g. a native control missing `accent-color` — that's themed once on `body` in `globals.css`).
- **Guardrail (`pnpm check:theme-tokens`, CI-enforced).** The inverse ratchet (`scripts/check-theme-tokens.mjs`): it fails CI when a semantic-token color utility (`bg-surface`, `text-body`, `border-edge`, …) references a token that has **no** matching `--color-*` entry in `globals.css`'s `@theme inline` block. Tailwind v4 emits no CSS for such a utility, so it goes **inert** — present in the DOM but styling nothing (this is how #1227 removing `--color-strong` silently blanked the unread dot's `bg-strong` in #1235; jsdom class-name assertions can't catch it because they check the string, not the computed style). Renaming or removing a token therefore fails at every stale call site. Palette colors (`bg-zinc-100`) are `check:colors`'s job and Tailwind structural utilities (`text-center`, `border-2`) are skipped; the residual non-class strings that merely look like utilities (SVG attribute names in `sanitize-svg.ts`, CSS properties, the `ui/text-link` import path) are snapshotted in `scripts/theme-token-baseline.json`. If you legitimately add such a string, run `pnpm check:theme-tokens --update` and commit the baseline diff — don't reach for `--update` to silence a genuinely dead token.

### Settings Sections

Settings pages are built from `SettingsSection` (`@/components/settings/SettingsSection`), which renders the standard heading + `Card` shell and handles loading/error/success states. Don't hand-roll the `<section><h2>…</h2><div className="rounded-lg border …">` pattern — use `SettingsSection`, or `SettingsSectionHeading` + `Card` when the content doesn't fit the wrapper.

### Guidelines

- **Use existing components** - Don't reimplement dialogs, buttons, cards, or navigation links
- **Use existing icons** - Check the icon list above before adding inline SVGs
- **Watch for patterns** - If you see the same UI pattern 3+ times, consider extracting a component
- **Include screenshots in frontend PRs** - When a change affects the UI, add before/after screenshots to the PR description whenever possible. For color/theme/token changes, capture all three themes (light, dark, e-paper). The `/demo` surface needs no auth (`https://lionreader.com/demo`, or a local `dev:local` server) and Playwright MCP (`mcp__Playwright__browser_*`) can drive it and screenshot. To capture a **before** shot without stashing, `git checkout master -- <files>` the UI files, screenshot (dev hot-reloads), then `git checkout HEAD -- <files>` to restore. Save shots under the gitignored `.playwright-mcp/` dir so they never get swept into a `git add -A`.
  - **Host screenshots on the `assets` branch, not `master`.** `assets` is an orphan branch holding binary assets referenced from PRs/docs so blobs never enter `master`'s history. One folder per topic (e.g. `unread-star-consistency-1203/`); reference from the PR body with raw URLs: `https://raw.githubusercontent.com/brendanlong/lion-reader/assets/<folder>/<file>.png`. Add the files via git **plumbing** (no checkout): load `origin/assets` into a temp index (`GIT_INDEX_FILE=… git read-tree origin/assets`), `git hash-object -w` each PNG + `git update-index --add --cacheinfo`, then `git write-tree` → `git commit-tree -p origin/assets` → `git push origin <commit>:refs/heads/assets`. See the `assets` branch `README.md` and its commit history for the pattern. **Never** commit screenshots to `master`/a feature branch, and **never** merge `assets` into `master`.
- **44px touch targets** - Ensure interactive elements meet WCAG touch target guidelines (handled by UI components)
- **Dark mode** - All UI components support dark mode via `dark:` Tailwind classes. The e-paper theme (`.epaper` on `<html>`) is light-like, so `dark:` variants don't apply to it; it restyles the app purely through the semantic-color CSS variables, plus colors that must gray safely (see the `.epaper` block in `globals.css`). When a component genuinely needs an e-paper-only override (e.g. a border that can't come from a token because e-paper has no background contrast), use the `epaper:` Tailwind variant — registered via `@custom-variant epaper` in `globals.css`, mirroring `dark:`. Reach for it sparingly; prefer the semantic tokens.

### When to Keep Icons Local

Some icons should remain as local components in their files:

- **Icons with `suppressHydrationWarning`** - Icons that depend on localStorage state (e.g., UnreadToggle) need this attribute on SVG elements, which shared icons don't support
- **Single-use custom icons** - Icons specific to one feature (e.g., empty state illustrations, media player skip icons) should stay local with a comment explaining why

## Narration OS Media Controls

Narration plays through the Web Speech API (browser voices) or the Web Audio API (Piper enhanced voices), neither of which the browser treats as media playback — so setting `navigator.mediaSession` metadata alone surfaces no OS controls (lock screen / notification widget, Bluetooth & media-key buttons), especially in an installed PWA. To make them appear, a **silent looping `<audio>` element** (`src/lib/narration/silent-audio.ts`, a runtime-generated silent WAV data URI) is played while narration is active; that element is what the browser recognizes as media, which surfaces the controls and routes hardware buttons into our action handlers. `src/lib/narration/media-session.ts` is provider-agnostic (plain `play`/`pause`/`stop`/`prev`/`next` callbacks) and the `useMediaSession` hook (`src/components/narration/`) keeps metadata, action handlers, and playback state in sync for **both** providers. Artwork falls back to the PWA manifest icons when no per-article image is supplied.
