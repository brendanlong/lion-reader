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
     * Main screen showing the entry list.
     * This is the default destination for authenticated users.
     */
    data object Main : Screen("main")

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
    }
}
