/**
 * KeyboardShortcutsSettings Component
 *
 * Settings section for keyboard shortcuts configuration.
 * Allows users to enable/disable keyboard shortcuts and view the shortcuts modal.
 */

"use client";

import { useKeyboardShortcutsContext } from "@/components/keyboard";

export function KeyboardShortcutsSettings() {
  const { enabled, setEnabled, openShortcutsModal } = useKeyboardShortcutsContext();

  return (
    <section>
      <h2 className="ui-text-xl mb-4 font-semibold text-zinc-900 dark:text-zinc-50">
        Keyboard Shortcuts
      </h2>
      <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
        {/* Enable/Disable Toggle */}
        <div className="flex items-center justify-between">
          <div>
            <h3 className="ui-text-base font-medium text-zinc-900 dark:text-zinc-50">
              Enable keyboard shortcuts
            </h3>
            <p className="ui-text-base mt-1 text-zinc-500 dark:text-zinc-400">
              Use keyboard shortcuts to navigate entries and perform actions quickly.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            onClick={() => setEnabled(!enabled)}
            className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:ring-2 focus:ring-zinc-500 focus:ring-offset-2 focus:outline-none dark:focus:ring-offset-zinc-900 ${
              enabled ? "bg-zinc-900 dark:bg-zinc-50" : "bg-zinc-200 dark:bg-zinc-700"
            }`}
          >
            <span
              aria-hidden="true"
              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out dark:bg-zinc-900 ${
                enabled ? "translate-x-5" : "translate-x-0"
              }`}
            />
          </button>
        </div>

        {/* View Shortcuts Button */}
        <div className="mt-6 border-t border-zinc-200 pt-6 dark:border-zinc-700">
          <button
            onClick={openShortcutsModal}
            className="ui-text-base inline-flex items-center gap-2 font-medium text-zinc-700 transition-colors hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-50"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            View all keyboard shortcuts
            {enabled && (
              <kbd className="ml-1 rounded border border-zinc-300 bg-zinc-100 px-1.5 py-0.5 font-mono text-xs font-medium text-zinc-600 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                ?
              </kbd>
            )}
          </button>
        </div>
      </div>
    </section>
  );
}
