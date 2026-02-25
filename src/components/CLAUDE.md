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
| **StatusCard**        | Colored card for info/success/warning/error states        |
| **ClientLink**        | Internal navigation links (use instead of Next.js Link)   |
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

### Guidelines

- **Use existing components** - Don't reimplement dialogs, buttons, cards, or navigation links
- **Use existing icons** - Check the icon list above before adding inline SVGs
- **Watch for patterns** - If you see the same UI pattern 3+ times, consider extracting a component
- **44px touch targets** - Ensure interactive elements meet WCAG touch target guidelines (handled by UI components)
- **Dark mode** - All UI components support dark mode via `dark:` Tailwind classes

### When to Keep Icons Local

Some icons should remain as local components in their files:

- **Icons with `suppressHydrationWarning`** - Icons that depend on localStorage state (e.g., UnreadToggle) need this attribute on SVG elements, which shared icons don't support
- **Single-use custom icons** - Icons specific to one feature (e.g., empty state illustrations, media player skip icons) should stay local with a comment explaining why
