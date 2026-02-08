/**
 * DemoSidebar Component
 *
 * Sidebar for the demo pages with reactive unread/starred counts.
 * Uses the same UI primitives as the real sidebar (NavLink, NavLinkWithIcon,
 * SubscriptionItem, ColorDot) with path-based navigation.
 *
 * Reads from DemoStateContext so counts update when entries are
 * marked read/unread or starred/unstarred.
 */

"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { NavLink, NavLinkWithIcon } from "@/components/ui/nav-link";
import { ColorDot } from "@/components/ui/color-picker";
import { ChevronDownIcon, ChevronRightIcon } from "@/components/ui/icon-button";
import { SubscriptionItem } from "@/components/layout/SubscriptionItem";
import { DEMO_TAGS, DEMO_SUBSCRIPTIONS, DEMO_ENTRIES, getDemoEntriesForSubscription } from "./data";
import { useDemoState } from "./DemoStateContext";

interface DemoSidebarProps {
  onClose: () => void;
}

export function DemoSidebar({ onClose }: DemoSidebarProps) {
  const pathname = usePathname();
  const demoState = useDemoState();

  // Features expanded by default, About collapsed
  const [expandedTags, setExpandedTags] = useState<Set<string>>(() => new Set(["features"]));

  const toggleTag = (tagId: string) => {
    setExpandedTags((prev) => {
      const next = new Set(prev);
      if (next.has(tagId)) {
        next.delete(tagId);
      } else {
        next.add(tagId);
      }
      return next;
    });
  };

  // Active state based on pathname
  const isAllActive = pathname === "/demo/all" || pathname === "/demo";
  const isHighlightsActive = pathname === "/demo/highlights";

  const isTagActive = (tagId: string) => {
    return pathname === `/demo/tag/${tagId}`;
  };

  const isSubActive = (subId: string) => {
    return pathname === `/demo/subscription/${subId}`;
  };

  // Reactive counts from demo state
  const totalUnread = demoState.countUnread(DEMO_ENTRIES);
  const highlightCount = demoState.countUnreadStarred();

  return (
    <nav className="flex h-full flex-col bg-white dark:bg-zinc-900">
      {/* Top navigation */}
      <div className="space-y-1 p-3">
        <NavLink
          href="/demo/all"
          isActive={isAllActive}
          countElement={
            totalUnread > 0 ? (
              <span className="ui-text-xs ml-2 shrink-0 text-zinc-500 dark:text-zinc-400">
                ({totalUnread})
              </span>
            ) : undefined
          }
          onClick={onClose}
        >
          All Features
        </NavLink>

        <NavLink
          href="/demo/highlights"
          isActive={isHighlightsActive}
          countElement={
            highlightCount > 0 ? (
              <span className="ui-text-xs ml-2 shrink-0 text-zinc-500 dark:text-zinc-400">
                ({highlightCount})
              </span>
            ) : undefined
          }
          onClick={onClose}
        >
          Highlights
        </NavLink>
      </div>

      {/* Divider */}
      <div className="mx-3 border-t border-zinc-200 dark:border-zinc-700" />

      {/* Tags and subscriptions */}
      <div className="flex-1 overflow-y-auto p-3">
        <ul className="space-y-1">
          {DEMO_TAGS.map((tag) => {
            const expanded = expandedTags.has(tag.id);
            const tagSubs = DEMO_SUBSCRIPTIONS.filter((s) => s.tagId === tag.id);
            const tagEntries = DEMO_ENTRIES.filter((e) =>
              tagSubs.some((s) => s.id === e.subscriptionId)
            );
            const tagUnread = demoState.countUnread(tagEntries);

            return (
              <li key={tag.id}>
                {/* Tag row */}
                <div className="flex min-h-[44px] items-center">
                  {/* Chevron button */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleTag(tag.id);
                    }}
                    className="flex h-6 w-6 shrink-0 items-center justify-center text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-300"
                    aria-label={expanded ? "Collapse" : "Expand"}
                  >
                    {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
                  </button>

                  {/* Tag link */}
                  <NavLinkWithIcon
                    href={`/demo/tag/${tag.id}`}
                    isActive={isTagActive(tag.id)}
                    icon={<ColorDot color={tag.color} size="sm" />}
                    label={tag.name}
                    count={tagUnread}
                    onClick={onClose}
                  />
                </div>

                {/* Nested subscriptions */}
                {expanded && (
                  <ul className="ml-6 space-y-0.5">
                    {tagSubs.map((sub) => {
                      const subEntries = getDemoEntriesForSubscription(sub.id);
                      const subUnread = demoState.countUnread(subEntries);
                      return (
                        <SubscriptionItem
                          key={sub.id}
                          subscription={{
                            id: sub.id,
                            title: sub.title,
                            unreadCount: subUnread,
                          }}
                          isActive={isSubActive(sub.id)}
                          href={`/demo/subscription/${sub.id}`}
                          onClose={onClose}
                          onEdit={() => {}}
                          onUnsubscribe={() => {}}
                        />
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
