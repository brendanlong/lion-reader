package com.lionreader.ui.entries

import com.lionreader.data.api.models.SortOrder

/**
 * UI state for the entry list screen.
 *
 * Contains all state needed to render the entry list, including filter settings,
 * loading states, and pagination information.
 *
 * @param title Title to display in the top app bar
 * @param unreadOnly Whether to show only unread entries
 * @param sortOrder Current sort order (newest first or oldest first)
 * @param hasMore Whether there are more entries to load (for infinite scroll)
 * @param isLoading Whether initial content is loading
 * @param isLoadingMore Whether additional content is being loaded (pagination)
 * @param isRefreshing Whether a pull-to-refresh operation is in progress
 * @param isOnline Whether the device has network connectivity
 * @param errorMessage Error message to display, null if no error
 */
data class EntryListUiState(
    val title: String = "All",
    val unreadOnly: Boolean = false,
    val sortOrder: SortOrder = SortOrder.NEWEST,
    val hasMore: Boolean = true,
    val isLoading: Boolean = true,
    val isLoadingMore: Boolean = false,
    val isRefreshing: Boolean = false,
    val isOnline: Boolean = true,
    val errorMessage: String? = null,
)
