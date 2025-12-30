package com.lionreader.ui.saved

/**
 * UI state for the saved articles list screen.
 *
 * @param title Title to display in the top app bar
 * @param unreadOnly Whether to show only unread articles
 * @param hasMore Whether there are more articles to load (for infinite scroll)
 * @param isLoading Whether initial content is loading
 * @param isLoadingMore Whether additional content is being loaded (pagination)
 * @param isRefreshing Whether a pull-to-refresh operation is in progress
 * @param errorMessage Error message to display, null if no error
 */
data class SavedArticlesUiState(
    val title: String = "Saved Articles",
    val unreadOnly: Boolean = false,
    val hasMore: Boolean = true,
    val isLoading: Boolean = true,
    val isLoadingMore: Boolean = false,
    val isRefreshing: Boolean = false,
    val errorMessage: String? = null,
)
