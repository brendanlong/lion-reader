package com.lionreader.ui.navigation

/**
 * Sealed class representing all navigation destinations in the app.
 *
 * Each screen has a unique route string used by the Navigation component.
 * This provides type-safe navigation throughout the app.
 */
sealed class Screen(
    val route: String,
) {
    /**
     * Login screen for email/password authentication.
     * This is the entry point for unauthenticated users.
     */
    data object Login : Screen("login")

    /**
     * Main screen container with navigation drawer.
     * This is the default destination for authenticated users.
     * Contains the entry list and drawer navigation.
     */
    data object Main : Screen("main")

    /**
     * All entries view - shows all entries across all subscriptions.
     * This is the default view when entering the main screen.
     */
    data object All : Screen("all") {
        const val TITLE = "All"
    }

    /**
     * Starred entries view - shows only starred/favorited entries.
     */
    data object Starred : Screen("starred") {
        const val TITLE = "Starred"
    }

    /**
     * Tag entries view - shows entries for subscriptions with a specific tag.
     * Requires a tag ID argument.
     */
    data object Tag : Screen("tag/{tagId}") {
        /**
         * Creates the route with the given tag ID.
         */
        fun createRoute(tagId: String): String = "tag/$tagId"
    }

    /**
     * Feed entries view - shows entries for a specific feed/subscription.
     * Requires a feed ID argument.
     */
    data object Feed : Screen("feed/{feedId}") {
        /**
         * Creates the route with the given feed ID.
         */
        fun createRoute(feedId: String): String = "feed/$feedId"
    }

    /**
     * Entry detail screen showing full article content.
     * Requires an entry ID argument and optional list context for swipe navigation.
     *
     * @param entryId The ID of the entry to display
     * @param listContext The route context from which this entry was opened (e.g., "all", "starred", "feed/xxx")
     *                    Used to determine adjacent entries for swipe navigation.
     */
    data object EntryDetail : Screen("entry/{entryId}?listContext={listContext}") {
        /**
         * Creates the route with the given entry ID and optional list context.
         *
         * @param entryId The entry ID to display
         * @param listContext The route from which this entry was opened, for swipe navigation context
         */
        fun createRoute(
            entryId: String,
            listContext: String? = null,
        ): String {
            val base = "entry/$entryId"
            return if (listContext != null) {
                "$base?listContext=$listContext"
            } else {
                base
            }
        }
    }

    /**
     * Saved articles list view - shows articles saved for later reading.
     */
    data object SavedArticles : Screen("saved") {
        const val TITLE = "Saved Articles"
    }

    /**
     * Uncategorized entries view - shows entries from subscriptions with no tags.
     */
    data object Uncategorized : Screen("uncategorized") {
        const val TITLE = "Uncategorized"
    }

    /**
     * Saved article detail screen showing full saved article content.
     * Requires a saved article ID argument.
     */
    data object SavedArticleDetail : Screen("saved/{savedArticleId}") {
        /**
         * Creates the route with the given saved article ID.
         */
        fun createRoute(savedArticleId: String): String = "saved/$savedArticleId"
    }

    companion object {
        /**
         * Route argument name for entry ID in EntryDetail screen.
         */
        const val ARG_ENTRY_ID = "entryId"

        /**
         * Route argument name for list context in EntryDetail screen.
         * Contains the route from which entry detail was opened (e.g., "all", "starred", "feed/xxx").
         */
        const val ARG_LIST_CONTEXT = "listContext"

        /**
         * Route argument name for tag ID in Tag screen.
         */
        const val ARG_TAG_ID = "tagId"

        /**
         * Route argument name for feed ID in Feed screen.
         */
        const val ARG_FEED_ID = "feedId"

        /**
         * Route argument name for saved article ID in SavedArticleDetail screen.
         */
        const val ARG_SAVED_ARTICLE_ID = "savedArticleId"
    }
}
