# Components

@docs/diagrams/frontend-data-flow.d2

## UI Components

Reusable UI primitives are in `src/components/ui/`. **Always check for existing components before creating new ones.** Import directly from source files, e.g. `import { Button } from "@/components/ui/button";`

### Available Components

| Component             | Purpose                                                   |
| --------------------- | --------------------------------------------------------- |
| **Button**            | Primary, secondary, ghost variants with loading state     |
| **Input**             | Text input with label and error handling                  |
| **Alert**             | Status messages (error, success, warning, info)           |
| **Dialog**            | Modal dialogs with backdrop, focus trap, escape handling  |
| **Card**              | Container with border, background, and consistent padding |
| **CardSection**       | Subsection within a Card, separated by a top border       |
| **NoteBox**           | Subtle zinc-tinted box for notes and secondary content    |
| **StatusCard**        | Colored card for info/success/warning/error states        |
| **ClientLink**        | Internal navigation links (use instead of Next.js Link)   |
| **TextLink**          | Accent-colored inline text link (`external` for new tab)  |
| **InlineCode**        | Small monospace chip for inline code, URLs, file names    |
| **Kbd**               | Keyboard key chip for displaying shortcut keys            |
| **NavLink**           | Sidebar navigation links with active state and counts     |
| **IconButton**        | Small icon-only action buttons (edit, close, etc.)        |
| **NotFoundCard**      | Card for 404/missing content states                       |
| **ColorPicker**       | Color selection with `ColorDot` preview                   |
| **StateToggleButton** | Toggle button with visual state indicator                 |

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

| Token                | Replaces                               | Use for                            |
| -------------------- | -------------------------------------- | ---------------------------------- |
| `text-strong`        | `text-zinc-900 dark:text-zinc-50`      | Headings, primary values           |
| `text-emphasis`      | `text-zinc-900 dark:text-zinc-200`     | `<strong>` inside muted prose      |
| `text-body`          | `text-zinc-700 dark:text-zinc-300`     | Body copy, labels                  |
| `text-muted`         | `text-zinc-600 dark:text-zinc-400`     | Descriptions, secondary text       |
| `text-subtle`        | `text-zinc-500 dark:text-zinc-400`     | Metadata, hints                    |
| `text-faint`         | `text-zinc-400 dark:text-zinc-500`     | De-emphasized notes, placeholders  |
| `bg-canvas`          | `bg-zinc-50 dark:bg-zinc-950`          | Page background behind the shell   |
| `bg-surface`         | `bg-white dark:bg-zinc-900`            | Cards, inputs, controls            |
| `bg-surface-muted`   | `bg-zinc-100 dark:bg-zinc-800`         | Chips, skeletons                   |
| `bg-surface-subtle`  | `bg-zinc-50 dark:bg-zinc-800/50`       | Note boxes, subtle fills           |
| `border-edge`        | `border-zinc-200 dark:border-zinc-800` | Card outlines (also `divide-edge`) |
| `border-edge-strong` | `border-zinc-200 dark:border-zinc-700` | Dividers, note-box borders         |

Interactive-state colors (`hover:bg-zinc-50`, focus rings, input borders) are not tokenized yet — keep using raw utilities with `dark:` variants for those.

### Settings Sections

Settings pages are built from `SettingsSection` (`@/components/settings/SettingsSection`), which renders the standard heading + `Card` shell and handles loading/error/success states. Don't hand-roll the `<section><h2>…</h2><div className="rounded-lg border …">` pattern — use `SettingsSection`, or `SettingsSectionHeading` + `Card` when the content doesn't fit the wrapper.

### Guidelines

- **Use existing components** - Don't reimplement dialogs, buttons, cards, or navigation links
- **Use existing icons** - Check the icon list above before adding inline SVGs
- **Watch for patterns** - If you see the same UI pattern 3+ times, consider extracting a component
- **44px touch targets** - Ensure interactive elements meet WCAG touch target guidelines (handled by UI components)
- **Dark mode** - All UI components support dark mode via `dark:` Tailwind classes. The e-paper theme (`.epaper` on `<html>`) is light-like, so `dark:` variants don't apply to it; it restyles the app purely through the semantic-color CSS variables, plus colors that must gray safely (see the `.epaper` block in `globals.css`). When a component genuinely needs an e-paper-only override (e.g. a border that can't come from a token because e-paper has no background contrast), use the `epaper:` Tailwind variant — registered via `@custom-variant epaper` in `globals.css`, mirroring `dark:`. Reach for it sparingly; prefer the semantic tokens.

### When to Keep Icons Local

Some icons should remain as local components in their files:

- **Icons with `suppressHydrationWarning`** - Icons that depend on localStorage state (e.g., UnreadToggle) need this attribute on SVG elements, which shared icons don't support
- **Single-use custom icons** - Icons specific to one feature (e.g., empty state illustrations, media player skip icons) should stay local with a comment explaining why
