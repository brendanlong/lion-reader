/**
 * Every keyboard shortcut in the app. Bindings pass `hotkey` straight to
 * `useHotkeys` and the help modal renders this table, so both use the same key
 * strings.
 */

export const SHORTCUT_SECTIONS = ["Navigation", "Actions", "Narration", "Help"] as const;

type ShortcutSection = (typeof SHORTCUT_SECTIONS)[number];

export interface ShortcutDefinition {
  /** react-hotkeys-hook key string: `,` separates alternatives, `+` joins modifiers. */
  readonly hotkey: string;
  /**
   * Key that must be pressed first (the "g then a" chords). useKeyboardShortcuts
   * tracks the prefix itself: react-hotkeys-hook's `>` sequences would also fire
   * the plain binding of the second key (`s` would star as well as go to Starred).
   */
  readonly prefix?: string;
  readonly description: string;
  readonly section: ShortcutSection;
}

export const SHORTCUTS = {
  nextEntry: {
    hotkey: "j",
    description: "Next entry (in list or when viewing)",
    section: "Navigation",
  },
  previousEntry: {
    hotkey: "k",
    description: "Previous entry (in list or when viewing)",
    section: "Navigation",
  },
  openEntry: { hotkey: "o, enter", description: "Open selected entry", section: "Navigation" },
  closeEntry: { hotkey: "escape", description: "Close entry / deselect", section: "Navigation" },
  // Shift+N / Shift+P are Google Reader's keys for the same thing.
  nextFeed: {
    hotkey: "shift+j, shift+n",
    description: "Next subscription or tag",
    section: "Navigation",
  },
  previousFeed: {
    hotkey: "shift+k, shift+p",
    description: "Previous subscription or tag",
    section: "Navigation",
  },
  goToAll: { prefix: "g", hotkey: "a", description: "Go to All items", section: "Navigation" },
  goToStarred: {
    prefix: "g",
    hotkey: "s",
    description: "Go to Starred items",
    section: "Navigation",
  },
  goToSaved: { prefix: "g", hotkey: "l", description: "Go to Saved items", section: "Navigation" },
  toggleRead: { hotkey: "m", description: "Toggle read/unread", section: "Actions" },
  toggleStar: { hotkey: "s", description: "Toggle star", section: "Actions" },
  markAllRead: { hotkey: "shift+a", description: "Mark all as read", section: "Actions" },
  toggleUnreadOnly: { hotkey: "u", description: "Toggle show/hide read items", section: "Actions" },
  openOriginal: { hotkey: "v", description: "Open original URL in new tab", section: "Actions" },
  refresh: { hotkey: "r", description: "Refresh current view", section: "Actions" },
  search: { hotkey: "/", description: "Search entries", section: "Actions" },
  playPause: { hotkey: "p", description: "Toggle play/pause", section: "Narration" },
  nextParagraph: { hotkey: "]", description: "Skip to next paragraph", section: "Narration" },
  previousParagraph: {
    hotkey: "[",
    description: "Skip to previous paragraph",
    section: "Narration",
  },
  showShortcuts: { hotkey: "shift+?", description: "Show keyboard shortcuts", section: "Help" },
} satisfies Record<string, ShortcutDefinition>;

export type ShortcutId = keyof typeof SHORTCUTS;

/** The alternatives in a `hotkey` string, as react-hotkeys-hook reports them to a callback. */
export function hotkeyAlternatives(hotkey: string): string[] {
  return hotkey.split(",").map((alternative) => alternative.trim().toLowerCase());
}

/**
 * How a hotkey alternative is shown: "shift+j" is "Shift+J", "escape" is
 * "Escape". Shift is dropped before a symbol, since the symbol already is the
 * shifted character ("shift+?" is "?").
 */
export function formatHotkey(alternative: string): string {
  const parts = alternative.split("+");
  const key = parts[parts.length - 1];
  const isLetter = /^[a-z]$/.test(key);
  const shift = parts.includes("shift");
  if (isLetter) return shift ? `Shift+${key.toUpperCase()}` : key;
  if (key.length === 1) return key;
  return key[0].toUpperCase() + key.slice(1);
}
