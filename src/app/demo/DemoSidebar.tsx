/**
 * DemoSidebar Component
 *
 * Static sidebar for the demo pages.
 * Uses the same UI primitives as the real sidebar (NavLink, NavLinkWithIcon,
 * SubscriptionItem, ColorDot) with path-based navigation.
 */

"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import {
  NavLink,
  NavLinkWithIcon,
  ColorDot,
  ChevronDownIcon,
  ChevronRightIcon,
} from "@/components/ui";
import { SubscriptionItem } from "@/components/layout/SubscriptionItem";
import {
  DEMO_TAGS,
  DEMO_SUBSCRIPTIONS,
  DEMO_ENTRIES,
  DEMO_TOTAL_COUNT,
  getDemoHighlightEntries,
  getDemoEntriesForSubscription,
} from "./data";

interface DemoSidebarProps {
  onClose: () => void;
}

export function DemoSidebar({ onClose }: DemoSidebarProps) {
  const pathname = usePathname();

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

  return (
    <nav className="flex h-full flex-col bg-white dark:bg-zinc-900">
      {/* Top navigation */}
      <div className="space-y-1 p-3">
        <NavLink
          href="/demo/all"
          isActive={isAllActive}
          countElement={
            <span className="ui-text-xs ml-2 shrink-0 text-zinc-500 dark:text-zinc-400">
              ({DEMO_TOTAL_COUNT})
            </span>
          }
          onClick={onClose}
        >
          All Features
        </NavLink>

        <NavLink
          href="/demo/highlights"
          isActive={isHighlightsActive}
          countElement={
            <span className="ui-text-xs ml-2 shrink-0 text-zinc-500 dark:text-zinc-400">
              ({getDemoHighlightEntries().length})
            </span>
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
                    count={
                      DEMO_ENTRIES.filter((e) => tagSubs.some((s) => s.id === e.subscriptionId))
                        .length
                    }
                    onClick={onClose}
                  />
                </div>

                {/* Nested subscriptions */}
                {expanded && (
                  <ul className="ml-6 space-y-0.5">
                    {tagSubs.map((sub) => (
                      <SubscriptionItem
                        key={sub.id}
                        subscription={{
                          id: sub.id,
                          title: sub.title,
                          unreadCount: getDemoEntriesForSubscription(sub.id).length,
                        }}
                        isActive={isSubActive(sub.id)}
                        href={`/demo/subscription/${sub.id}`}
                        onClose={onClose}
                        onEdit={() => {}}
                        onUnsubscribe={() => {}}
                      />
                    ))}
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
