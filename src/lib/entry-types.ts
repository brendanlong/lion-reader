/**
 * What clients see as the source of a saved article, and Google Reader as the
 * saved subscription's title (#730).
 */
export const SAVED_ARTICLES_TITLE = "Saved Articles";

/** The kinds of entry. */
export const ENTRY_TYPES = ["web", "email", "saved"] as const;

export type EntryType = (typeof ENTRY_TYPES)[number];

/** The kinds of subscription: one per entry type, plus collections, which hold no entries of their own. */
export const SUBSCRIPTION_TYPES = [...ENTRY_TYPES, "collection"] as const;
