/**
 * The `subscriptions.list` input the app always loads to learn the user's
 * saved subscription (#1846), shared by the server prefetch and the client
 * hook (`useSavedSubscriptionId`) so their cache keys match.
 *
 * Saved is a membership like a collection: an entry is in the Saved list when
 * its `subscriptionIds` hold the saved subscription's id, whatever its `type`.
 * Every `subscriptions.list` result names that id (the local store keeps the
 * latest, `LocalDb.saved`), but the sidebar's own lists aren't
 * loaded while their sections are collapsed. This one lists the user's
 * saved-type subscriptions: none, since the server keeps the saved
 * subscription out of lists until #1846 phase 9, but the result still names
 * it.
 */
export const SAVED_SUBSCRIPTION_LIST_INPUT = { type: "saved", limit: 1 } as const;
