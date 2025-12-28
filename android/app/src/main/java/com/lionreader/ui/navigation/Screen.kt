package com.lionreader.ui.navigation

/**
 * Sealed class representing all navigation destinations in the app.
 *
 * Each screen has a unique route string used by the Navigation component.
 * This provides type-safe navigation throughout the app.
 */
sealed class Screen(val route: String) {

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
     * Requires an entry ID argument.
     */
    data object EntryDetail : Screen("entry/{entryId}") {
        /**
         * Creates the route with the given entry ID.
         */
        fun createRoute(entryId: String): String = "entry/$entryId"
    }

    companion object {
        /**
         * Route argument name for entry ID in EntryDetail screen.
         */
        const val ARG_ENTRY_ID = "entryId"

        /**
         * Route argument name for tag ID in Tag screen.
         */
        const val ARG_TAG_ID = "tagId"

        /**
         * Route argument name for feed ID in Feed screen.
         */
        const val ARG_FEED_ID = "feedId"
    }
}
