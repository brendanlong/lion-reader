package com.lionreader.ui.entries

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.lionreader.data.api.models.SortOrder
import com.lionreader.data.db.relations.EntryWithState
import com.lionreader.data.repository.EntryFilters
import com.lionreader.data.repository.EntryRepository
import com.lionreader.data.repository.SubscriptionRepository
import com.lionreader.data.repository.TagRepository
import com.lionreader.data.sync.ConnectivityMonitorInterface
import com.lionreader.ui.navigation.Screen
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * ViewModel for the entry list screen.
 *
 * Manages entry list state including filtering, pagination, and actions.
 * Uses an offline-first approach where entries are always read from the
 * local database and sync happens in the background.
 *
 * Supports dynamic route updates via [setRoute] for integration with
 * parent screens that manage navigation internally.
 *
 * @param savedStateHandle Used to retrieve and persist filter parameters
 * @param entryRepository Repository for entry operations
 * @param subscriptionRepository Repository for subscription data (for titles)
 * @param tagRepository Repository for tag data (for titles)
 * @param connectivityMonitor Monitor for network connectivity status
 */
@HiltViewModel
class EntryListViewModel
    @Inject
    constructor(
        private val savedStateHandle: SavedStateHandle,
        private val entryRepository: EntryRepository,
        private val subscriptionRepository: SubscriptionRepository,
        private val tagRepository: TagRepository,
        private val connectivityMonitor: ConnectivityMonitorInterface,
    ) : ViewModel() {
        companion object {
            private const val PAGE_SIZE = 50
            private const val KEY_UNREAD_ONLY = "unreadOnly"
            private const val KEY_SORT_ORDER = "sortOrder"
            private const val KEY_CURRENT_ROUTE = "currentRoute"
        }

        // Route-based filter parameters (updated via setRoute)
        private val _feedId = MutableStateFlow<String?>(null)
        private val _tagId = MutableStateFlow<String?>(null)
        private val _starredOnly = MutableStateFlow(false)
        private val _currentRoute =
            MutableStateFlow(
                savedStateHandle.get<String>(KEY_CURRENT_ROUTE) ?: Screen.All.route,
            )

        // Mutable filter state
        private val _unreadOnly =
            MutableStateFlow(
                savedStateHandle.get<Boolean>(KEY_UNREAD_ONLY) ?: false,
            )
        private val _sortOrder =
            MutableStateFlow(
                savedStateHandle.get<String>(KEY_SORT_ORDER)?.let { SortOrder.valueOf(it) }
                    ?: SortOrder.NEWEST,
            )
        private val _currentOffset = MutableStateFlow(0)
        private val _hasMore = MutableStateFlow(true)
        private val _isLoadingMore = MutableStateFlow(false)

        // UI state
        private val _uiState =
            MutableStateFlow(
                EntryListUiState(
                    title = Screen.All.TITLE,
                    unreadOnly = _unreadOnly.value,
                    sortOrder = _sortOrder.value,
                    isOnline = connectivityMonitor.checkOnline(),
                ),
            )
        val uiState: StateFlow<EntryListUiState> = _uiState.asStateFlow()

        // Combined filters flow for reactive query updates
        @OptIn(ExperimentalCoroutinesApi::class)
        private val filtersFlow =
            combine(
                _feedId,
                _tagId,
                _starredOnly,
                _unreadOnly,
                _sortOrder,
                _currentOffset,
            ) { values ->
                @Suppress("UNCHECKED_CAST")
                val feedId = values[0] as String?
                val tagId = values[1] as String?
                val starredOnly = values[2] as Boolean
                val unreadOnly = values[3] as Boolean
                val sortOrder = values[4] as SortOrder
                val offset = values[5] as Int

                EntryFilters(
                    feedId = feedId,
                    tagId = tagId,
                    unreadOnly = unreadOnly,
                    starredOnly = starredOnly,
                    sortOrder = sortOrder,
                    limit = PAGE_SIZE + offset,
                    offset = 0, // Always fetch from beginning, we handle pagination via limit
                )
            }

        // Entries from local database, reactive to filter changes
        @OptIn(ExperimentalCoroutinesApi::class)
        private val _entriesFromDb =
            filtersFlow.flatMapLatest { filters ->
                entryRepository.getEntries(filters)
            }

        /**
         * Entries to display in the list.
         *
         * This is a reactive flow from the local database that automatically
         * updates when entries change or filters are modified.
         */
        val entries: StateFlow<List<EntryWithState>> =
            _entriesFromDb.stateIn(
                scope = viewModelScope,
                started = SharingStarted.WhileSubscribed(5000),
                initialValue = emptyList(),
            )

        init {
            // Observe connectivity status
            viewModelScope.launch {
                connectivityMonitor.isOnline.collect { isOnline ->
                    _uiState.value = _uiState.value.copy(isOnline = isOnline)
                }
            }

            // Parse initial route
            parseAndApplyRoute(_currentRoute.value)
        }

        /**
         * Sets the current route and updates filters accordingly.
         *
         * Call this when the navigation route changes to update the entry list
         * to show the appropriate entries.
         *
         * @param route The route string (e.g., "all", "starred", "tag/xxx", "feed/xxx")
         */
        fun setRoute(route: String) {
            if (route == _currentRoute.value) return

            _currentRoute.value = route
            savedStateHandle[KEY_CURRENT_ROUTE] = route

            // Reset pagination when route changes
            _currentOffset.value = 0
            _hasMore.value = true

            parseAndApplyRoute(route)
        }

        /**
         * Parses a route string and applies the appropriate filters.
         */
        private fun parseAndApplyRoute(route: String) {
            // Parse route to extract filter parameters
            val newFeedId: String?
            val newTagId: String?
            val newStarredOnly: Boolean
            val staticTitle: String

            when {
                route == Screen.Starred.route -> {
                    newFeedId = null
                    newTagId = null
                    newStarredOnly = true
                    staticTitle = Screen.Starred.TITLE
                }
                route.startsWith("tag/") -> {
                    newFeedId = null
                    newTagId = route.removePrefix("tag/")
                    newStarredOnly = false
                    staticTitle = "Tag" // Will be resolved dynamically
                }
                route.startsWith("feed/") -> {
                    newFeedId = route.removePrefix("feed/")
                    newTagId = null
                    newStarredOnly = false
                    staticTitle = "Feed" // Will be resolved dynamically
                }
                else -> {
                    // Default to "all"
                    newFeedId = null
                    newTagId = null
                    newStarredOnly = false
                    staticTitle = Screen.All.TITLE
                }
            }

            // Update filter state
            _feedId.value = newFeedId
            _tagId.value = newTagId
            _starredOnly.value = newStarredOnly

            // Update UI with static title first
            _uiState.value =
                _uiState.value.copy(
                    title = staticTitle,
                    isLoading = true,
                )

            // Resolve dynamic title and sync
            viewModelScope.launch {
                val dynamicTitle = resolveDynamicTitle(newFeedId, newTagId, newStarredOnly)
                _uiState.value = _uiState.value.copy(title = dynamicTitle)
                syncEntries()
            }
        }

        /**
         * Resolves the dynamic title for tag/feed routes.
         */
        private suspend fun resolveDynamicTitle(
            feedId: String?,
            tagId: String?,
            starredOnly: Boolean,
        ): String =
            when {
                starredOnly -> Screen.Starred.TITLE
                feedId != null -> {
                    subscriptionRepository.getSubscriptionByFeedId(feedId)?.displayTitle ?: "Feed"
                }
                tagId != null -> {
                    tagRepository.getTag(tagId)?.name ?: "Tag"
                }
                else -> Screen.All.TITLE
            }

        /**
         * Syncs entries from the server.
         */
        private suspend fun syncEntries() {
            _uiState.value = _uiState.value.copy(isLoading = true, errorMessage = null)

            try {
                val result =
                    entryRepository.syncEntries(
                        EntryFilters(
                            feedId = _feedId.value,
                            tagId = _tagId.value,
                            unreadOnly = _unreadOnly.value,
                            starredOnly = _starredOnly.value,
                            sortOrder = _sortOrder.value,
                            limit = PAGE_SIZE,
                        ),
                    )

                _hasMore.value = result.hasMore
                _uiState.value =
                    _uiState.value.copy(
                        isLoading = false,
                        hasMore = result.hasMore,
                    )
            } catch (e: Exception) {
                _uiState.value =
                    _uiState.value.copy(
                        isLoading = false,
                        errorMessage = e.message ?: "Failed to load entries",
                    )
            }
        }

        /**
         * Toggles the unread-only filter.
         *
         * When enabled, only unread entries are shown.
         * When disabled, all entries (read and unread) are shown.
         */
        fun toggleUnreadOnly() {
            val newValue = !_unreadOnly.value
            _unreadOnly.value = newValue
            savedStateHandle[KEY_UNREAD_ONLY] = newValue
            _currentOffset.value = 0
            _hasMore.value = true
            _uiState.value =
                _uiState.value.copy(
                    unreadOnly = newValue,
                    hasMore = true,
                )

            // Re-sync with new filter
            viewModelScope.launch {
                syncEntries()
            }
        }

        /**
         * Toggles the sort order between newest and oldest first.
         */
        fun toggleSortOrder() {
            val newValue =
                if (_sortOrder.value == SortOrder.NEWEST) {
                    SortOrder.OLDEST
                } else {
                    SortOrder.NEWEST
                }
            _sortOrder.value = newValue
            savedStateHandle[KEY_SORT_ORDER] = newValue.name
            _currentOffset.value = 0
            _hasMore.value = true
            _uiState.value =
                _uiState.value.copy(
                    sortOrder = newValue,
                    hasMore = true,
                )

            // Re-sync with new sort order
            viewModelScope.launch {
                syncEntries()
            }
        }

        /**
         * Toggles the read status of an entry.
         *
         * @param entryId The ID of the entry to toggle
         */
        fun toggleRead(entryId: String) {
            viewModelScope.launch {
                entryRepository.toggleRead(entryId)
            }
        }

        /**
         * Toggles the starred status of an entry.
         *
         * @param entryId The ID of the entry to toggle
         */
        fun toggleStar(entryId: String) {
            viewModelScope.launch {
                entryRepository.toggleStarred(entryId)
            }
        }

        /**
         * Loads more entries for infinite scroll.
         *
         * Increments the offset and fetches the next page of entries from the server.
         * Does nothing if already loading or no more entries are available.
         */
        fun loadMore() {
            if (_isLoadingMore.value || !_hasMore.value) return

            viewModelScope.launch {
                _isLoadingMore.value = true
                _uiState.value = _uiState.value.copy(isLoadingMore = true)

                try {
                    val newOffset = _currentOffset.value + PAGE_SIZE
                    _currentOffset.value = newOffset

                    val result =
                        entryRepository.syncEntries(
                            EntryFilters(
                                feedId = _feedId.value,
                                tagId = _tagId.value,
                                unreadOnly = _unreadOnly.value,
                                starredOnly = _starredOnly.value,
                                sortOrder = _sortOrder.value,
                                limit = PAGE_SIZE,
                                offset = newOffset,
                            ),
                        )

                    _hasMore.value = result.hasMore
                    _uiState.value =
                        _uiState.value.copy(
                            isLoadingMore = false,
                            hasMore = result.hasMore,
                        )
                } catch (e: Exception) {
                    _uiState.value =
                        _uiState.value.copy(
                            isLoadingMore = false,
                            errorMessage = e.message,
                        )
                } finally {
                    _isLoadingMore.value = false
                }
            }
        }

        /**
         * Refreshes entries from the server (pull-to-refresh).
         *
         * Resets pagination and fetches fresh data from the server.
         * Handles offline gracefully by showing cached data.
         */
        fun refresh() {
            viewModelScope.launch {
                _uiState.value = _uiState.value.copy(isRefreshing = true, errorMessage = null)
                _currentOffset.value = 0
                _hasMore.value = true

                try {
                    // First sync pending actions if online
                    if (connectivityMonitor.checkOnline()) {
                        entryRepository.syncFromServer()
                    }

                    val result =
                        entryRepository.syncEntries(
                            EntryFilters(
                                feedId = _feedId.value,
                                tagId = _tagId.value,
                                unreadOnly = _unreadOnly.value,
                                starredOnly = _starredOnly.value,
                                sortOrder = _sortOrder.value,
                                limit = PAGE_SIZE,
                            ),
                        )

                    _hasMore.value = result.hasMore
                    _uiState.value =
                        _uiState.value.copy(
                            isRefreshing = false,
                            hasMore = result.hasMore,
                        )
                } catch (e: Exception) {
                    // Even if sync fails, we still have local data
                    _uiState.value =
                        _uiState.value.copy(
                            isRefreshing = false,
                            errorMessage =
                                if (!connectivityMonitor.checkOnline()) {
                                    "You're offline. Showing cached entries."
                                } else {
                                    e.message ?: "Failed to refresh"
                                },
                        )
                }
            }
        }

        /**
         * Clears any error message being displayed.
         */
        fun clearError() {
            _uiState.value = _uiState.value.copy(errorMessage = null)
        }
    }
