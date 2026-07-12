/**
 * EnhancedVoicesHelp Component
 *
 * Collapsible help section with FAQ about enhanced voices.
 * Provides user-friendly documentation about the enhanced TTS feature.
 *
 * @module components/narration/EnhancedVoicesHelp
 */

"use client";

import { useState } from "react";
import { ChevronDownIcon, QuestionCircleIcon } from "@/components/ui/icon-button";

/**
 * FAQ item definition.
 */
interface FAQItem {
  question: string;
  answer: string;
}

/**
 * FAQ items for enhanced voices.
 */
const FAQ_ITEMS: FAQItem[] = [
  {
    question: "What are enhanced voices?",
    answer:
      "Enhanced voices are high-quality text-to-speech voices that run directly in your browser. They provide more natural-sounding narration compared to standard browser voices and work consistently across all browsers.",
  },
  {
    question: "Why use enhanced voices instead of browser voices?",
    answer:
      "Enhanced voices offer better audio quality and work reliably in all browsers, including Firefox where browser voices can have issues. They also work offline once downloaded, so you can listen to articles without an internet connection.",
  },
  {
    question: "How much storage do enhanced voices use?",
    answer:
      "Each voice uses between 17-50 MB of storage depending on quality. Low quality voices are smaller (~17 MB) while medium quality voices are larger (~50 MB). You can download multiple voices, but a warning appears if total storage exceeds 200 MB.",
  },
  {
    question: "Can I use enhanced voices offline?",
    answer:
      "Yes! Once you download an enhanced voice, it is stored in your browser and works without an internet connection. This is great for reading articles on planes, trains, or anywhere without reliable internet.",
  },
  {
    question: "What happens if a download fails?",
    answer:
      "If a download fails, you will see an error message with a Retry button. Common causes include poor internet connection or low storage space. Simply click Retry to try again, or check your connection and try later.",
  },
  {
    question: "How do I free up storage space?",
    answer:
      'Click the trash icon next to any downloaded voice to remove it. If you have multiple voices downloaded, you can also use the "Delete All" link to remove all voices at once. Deleted voices can be re-downloaded at any time.',
  },
];

/**
 * Individual FAQ item component with expand/collapse functionality.
 */
function FAQItemComponent({
  item,
  isOpen,
  onToggle,
}: {
  item: FAQItem;
  isOpen: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="border-edge-strong border-b last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between py-3 text-left"
        aria-expanded={isOpen}
      >
        <span className="ui-text-sm text-body font-medium">{item.question}</span>
        <ChevronDownIcon
          className={`text-subtle h-4 w-4 flex-shrink-0 transition-transform duration-200 ${
            isOpen ? "rotate-180" : ""
          }`}
        />
      </button>
      {isOpen && (
        <div className="pr-8 pb-3">
          <p className="ui-text-sm text-muted">{item.answer}</p>
        </div>
      )}
    </div>
  );
}

/**
 * Enhanced voices help section with collapsible FAQ.
 *
 * Displays a "Help with enhanced voices" button that expands to show
 * frequently asked questions about the enhanced TTS feature.
 *
 * @returns The enhanced voices help component.
 *
 * @example
 * ```tsx
 * function NarrationSettings() {
 *   return (
 *     <div>
 *       <EnhancedVoiceList ... />
 *       <EnhancedVoicesHelp />
 *     </div>
 *   );
 * }
 * ```
 */
export function EnhancedVoicesHelp() {
  const [isExpanded, setIsExpanded] = useState(false);
  const [openItemIndex, setOpenItemIndex] = useState<number | null>(null);

  const handleToggleItem = (index: number) => {
    setOpenItemIndex(openItemIndex === index ? null : index);
  };

  return (
    <div className="border-edge-strong rounded-lg border">
      {/* Header button */}
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
        aria-expanded={isExpanded}
      >
        <div className="flex items-center gap-2">
          <QuestionCircleIcon className="text-subtle h-4 w-4" />
          <span className="ui-text-sm text-body font-medium">Help with enhanced voices</span>
        </div>
        <ChevronDownIcon
          className={`text-subtle h-4 w-4 transition-transform duration-200 ${
            isExpanded ? "rotate-180" : ""
          }`}
        />
      </button>

      {/* Expandable FAQ content */}
      {isExpanded && (
        <div className="border-edge-strong border-t px-4">
          {FAQ_ITEMS.map((item, index) => (
            <FAQItemComponent
              key={index}
              item={item}
              isOpen={openItemIndex === index}
              onToggle={() => handleToggleItem(index)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
