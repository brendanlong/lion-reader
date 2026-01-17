/**
 * ZustandDebug Component
 *
 * Displays the current Zustand realtime store state for debugging.
 * Add this component anywhere in your app to see live state updates.
 */

"use client";

import { useState } from "react";
import { useRealtimeStore } from "@/lib/store/realtime";

export function ZustandDebug() {
  const [isOpen, setIsOpen] = useState(true);

  // Subscribe to all store state
  const state = useRealtimeStore();

  // Convert Sets to Arrays for display
  const readIds = Array.from(state.readIds);
  const unreadIds = Array.from(state.unreadIds);
  const starredIds = Array.from(state.starredIds);
  const unstarredIds = Array.from(state.unstarredIds);
  const newEntryIds = Array.from(state.newEntryIds);

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="ui-text-sm fixed right-4 bottom-4 z-50 rounded bg-blue-600 px-4 py-2 text-white shadow-lg hover:bg-blue-700"
      >
        🐛 Show Zustand Debug
      </button>
    );
  }

  return (
    <div className="ui-text-xs fixed right-4 bottom-4 z-50 max-h-[80vh] w-[600px] overflow-auto rounded-lg border border-gray-300 bg-white p-4 font-mono shadow-2xl dark:border-gray-700 dark:bg-gray-900">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="ui-text-sm font-bold">🔄 Zustand Realtime Store</h3>
        <button
          onClick={() => setIsOpen(false)}
          className="ui-text-xs rounded px-2 py-1 hover:bg-gray-100 dark:hover:bg-gray-800"
        >
          ✕
        </button>
      </div>

      <div className="space-y-3">
        <Section title="📖 Read IDs" count={readIds.length}>
          {readIds.length > 0 ? (
            <ul className="list-disc pl-5">
              {readIds.slice(0, 5).map((id) => (
                <li key={id} className="truncate">
                  {id}
                </li>
              ))}
              {readIds.length > 5 && <li>... and {readIds.length - 5} more</li>}
            </ul>
          ) : (
            <p className="text-gray-500">None</p>
          )}
        </Section>

        <Section title="📕 Unread IDs" count={unreadIds.length}>
          {unreadIds.length > 0 ? (
            <ul className="list-disc pl-5">
              {unreadIds.slice(0, 5).map((id) => (
                <li key={id} className="truncate">
                  {id}
                </li>
              ))}
              {unreadIds.length > 5 && <li>... and {unreadIds.length - 5} more</li>}
            </ul>
          ) : (
            <p className="text-gray-500">None</p>
          )}
        </Section>

        <Section title="⭐ Starred IDs" count={starredIds.length}>
          {starredIds.length > 0 ? (
            <ul className="list-disc pl-5">
              {starredIds.slice(0, 5).map((id) => (
                <li key={id} className="truncate">
                  {id}
                </li>
              ))}
              {starredIds.length > 5 && <li>... and {starredIds.length - 5} more</li>}
            </ul>
          ) : (
            <p className="text-gray-500">None</p>
          )}
        </Section>

        <Section title="☆ Unstarred IDs" count={unstarredIds.length}>
          {unstarredIds.length > 0 ? (
            <ul className="list-disc pl-5">
              {unstarredIds.slice(0, 5).map((id) => (
                <li key={id} className="truncate">
                  {id}
                </li>
              ))}
              {unstarredIds.length > 5 && <li>... and {unstarredIds.length - 5} more</li>}
            </ul>
          ) : (
            <p className="text-gray-500">None</p>
          )}
        </Section>

        <Section title="📊 Subscription Count Deltas">
          {Object.keys(state.subscriptionCountDeltas).length > 0 ? (
            <div className="space-y-1">
              {Object.entries(state.subscriptionCountDeltas)
                .slice(0, 10)
                .map(([subId, delta]) => (
                  <div key={subId} className="flex justify-between">
                    <span className="truncate">{subId.slice(0, 8)}...</span>
                    <span
                      className={delta > 0 ? "text-green-600" : delta < 0 ? "text-red-600" : ""}
                    >
                      {delta > 0 ? "+" : ""}
                      {delta}
                    </span>
                  </div>
                ))}
              {Object.keys(state.subscriptionCountDeltas).length > 10 && (
                <p>... and {Object.keys(state.subscriptionCountDeltas).length - 10} more</p>
              )}
            </div>
          ) : (
            <p className="text-gray-500">None</p>
          )}
        </Section>

        <Section title="🏷️ Tag Count Deltas">
          {Object.keys(state.tagCountDeltas).length > 0 ? (
            <div className="space-y-1">
              {Object.entries(state.tagCountDeltas)
                .slice(0, 10)
                .map(([tagId, delta]) => (
                  <div key={tagId} className="flex justify-between">
                    <span className="truncate">{tagId.slice(0, 8)}...</span>
                    <span
                      className={delta > 0 ? "text-green-600" : delta < 0 ? "text-red-600" : ""}
                    >
                      {delta > 0 ? "+" : ""}
                      {delta}
                    </span>
                  </div>
                ))}
              {Object.keys(state.tagCountDeltas).length > 10 && (
                <p>... and {Object.keys(state.tagCountDeltas).length - 10} more</p>
              )}
            </div>
          ) : (
            <p className="text-gray-500">None</p>
          )}
        </Section>

        <Section title="🆕 New Entry IDs (SSE)" count={newEntryIds.length}>
          {newEntryIds.length > 0 ? (
            <ul className="list-disc pl-5">
              {newEntryIds.slice(0, 5).map((id) => (
                <li key={id} className="truncate">
                  {id}
                </li>
              ))}
              {newEntryIds.length > 5 && <li>... and {newEntryIds.length - 5} more</li>}
            </ul>
          ) : (
            <p className="text-gray-500">None</p>
          )}
        </Section>

        <Section title="📥 Pending Entries" count={state.pendingEntries.length}>
          {state.pendingEntries.length > 0 ? (
            <ul className="list-disc pl-5">
              {state.pendingEntries.slice(0, 3).map((entry) => (
                <li key={entry.id} className="truncate">
                  {entry.id} (sub: {entry.subscriptionId.slice(0, 8)}...)
                </li>
              ))}
              {state.pendingEntries.length > 3 && (
                <li>... and {state.pendingEntries.length - 3} more</li>
              )}
            </ul>
          ) : (
            <p className="text-gray-500">None</p>
          )}
        </Section>

        <div className="pt-2 text-center text-gray-500">
          <p className="ui-text-xs">Updates automatically as state changes</p>
          <p className="ui-text-xs">
            Open Redux DevTools for detailed action history →{" "}
            <a
              href="https://chromewebstore.google.com/detail/redux-devtools/lmhkpmbekcpmknklioeibfkpmmfibljd"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline"
            >
              Install
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  children,
  count,
}: {
  title: string;
  children: React.ReactNode;
  count?: number;
}) {
  return (
    <div className="rounded border border-gray-200 p-2 dark:border-gray-700">
      <h4 className="mb-1 font-semibold">
        {title} {count !== undefined && `(${count})`}
      </h4>
      <div className="text-gray-700 dark:text-gray-300">{children}</div>
    </div>
  );
}
