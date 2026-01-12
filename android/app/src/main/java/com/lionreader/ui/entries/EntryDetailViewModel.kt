package com.lionreader.ui.entries

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.lionreader.data.db.relations.EntryWithState
import com.lionreader.data.repository.EntryFetchResult
import com.lionreader.data.repository.EntryRepository
import com.lionreader.data.sync.SyncErrorNotifier
import com.lionreader.ui.navigation.Screen
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * UI state for the entry detail screen.
 */
data class EntryDetailUiState(
    val isLoading: Boolean = true,
    val entry: EntryWithState? = null,
    val errorMessage: String? = null,
)

/**
 * Navigation state for swipe navigation between entries.
 */
data class SwipeNavigationState(
    /** List of entry IDs in display order */
    val entryIds: List<String> = emptyList(),
    /** Current position in the entry IDs list */
    val currentIndex: Int = -1,
    /** The list context route (e.g., "all", "starred", "subscription/xxx") */
    val listContext: String? = null,
    /** Preloaded previous entry (if available) */
    val previousEntry: EntryWithState? = null,
    /** Preloaded next entry (if available) */
    val nextEntry: EntryWithState? = null,
) {
    /** Whether there is a previous entry to navigate to */
    val hasPrevious: Boolean get() = currentIndex > 0

    /** Whether there is a next entry to navigate to */
    val hasNext: Boolean get() = currentIndex >= 0 && currentIndex < entryIds.size - 1

    /** ID of the previous entry, or null if at the beginning */
    val previousEntryId: String? get() = if (hasPrevious) entryIds[currentIndex - 1] else null

    /** ID of the next entry, or null if at the end */
    val nextEntryId: String? get() = if (hasNext) entryIds[currentIndex + 1] else null
}

/**
 * Events emitted by the ViewModel that require Activity handling.
 *
 * These events are one-shot and need to be handled by the Activity
 * to perform actions like sharing or opening a browser.
 */
sealed class EntryDetailEvent {
    /**
     * Request to share the article URL and title.
     */
    data class Share(
        val url: String,
        val title: String,
    ) : EntryDetailEvent()

    /**
     * Request to open the article URL in an external browser.
     */
    data class OpenInBrowser(
        val url: String,
    ) : EntryDetailEvent()
}

/**
 * ViewModel for the entry detail screen.
 *
 * Manages entry loading, read/star state, and actions like sharing
 * and opening in browser. Uses an offline-first approach where the
 * entry is first loaded from local storage, then fetched from the
 * server if not available.
 *
 * @param savedStateHandle Used to retrieve the entry ID from navigation arguments
 * @param entryRepository Repository for entry operations
 */
@HiltViewModel
class EntryDetailViewModel
    @Inject
    constructor(
        private val savedStateHandle: SavedStateHandle,
        private val entryRepository: EntryRepository,
        private val syncErrorNotifier: SyncErrorNotifier,
    ) : ViewModel() {
        /**
         * The entry ID retrieved from navigation arguments.
         */
        private val entryId: String = savedStateHandle.get<String>(Screen.ARG_ENTRY_ID) ?: ""

        /**
         * The list context for swipe navigation, retrieved from navigation arguments.
         */
        private val listContext: String? = savedStateHandle.get<String>(Screen.ARG_LIST_CONTEXT)

        /**
         * UI state for the entry detail screen.
         */
        private val _uiState = MutableStateFlow(EntryDetailUiState())
        val uiState: StateFlow<EntryDetailUiState> = _uiState.asStateFlow()

        /**
         * Current entry with its read/starred state.
         */
        private val _entry = MutableStateFlow<EntryWithState?>(null)
        val entry: StateFlow<EntryWithState?> = _entry.asStateFlow()

        /**
         * Swipe navigation state for navigating between entries.
         */
        private val _swipeNavState = MutableStateFlow(SwipeNavigationState())
        val swipeNavState: StateFlow<SwipeNavigationState> = _swipeNavState.asStateFlow()

        /**
         * Channel for one-shot events that need Activity handling.
         */
        private val _events = Channel<EntryDetailEvent>(Channel.BUFFERED)
        val events = _events.receiveAsFlow()

        init {
            // Observe sync errors
            viewModelScope.launch {
                syncErrorNotifier.errors.collect { error ->
                    _uiState.value = _uiState.value.copy(errorMessage = error.message)
                }
            }

            if (entryId.isNotEmpty()) {
                loadEntry()
                loadSwipeNavigationContext()
            } else {
                _uiState.value =
                    EntryDetailUiState(
                        isLoading = false,
                        errorMessage = "Invalid entry ID",
                    )
            }
        }

        /**
         * Loads the swipe navigation context (entry IDs for the current list).
         */
        private fun loadSwipeNavigationContext() {
            if (listContext == null) return

            viewModelScope.launch {
                val entryIds = entryRepository.getEntryIdsForContext(listContext)
                val currentIndex = entryIds.indexOf(entryId)

                _swipeNavState.value =
                    SwipeNavigationState(
                        entryIds = entryIds,
                        currentIndex = currentIndex,
                        listContext = listContext,
                    )

                // Preload adjacent entries for instant swipe navigation
                preloadAdjacentEntries(entryIds, currentIndex)
            }
        }

        /**
         * Preloads adjacent entries for smoother swipe navigation.
         *
         * Fetches the previous and next entries in parallel so their content
         * is cached locally before the user swipes. Also observes the database
         * to update the UI state when entries become available.
         *
         * @param entryIds List of all entry IDs in the current context
         * @param currentIndex Index of the current entry
         */
        private fun preloadAdjacentEntries(
            entryIds: List<String>,
            currentIndex: Int,
        ) {
            // Preload and observe previous entry
            if (currentIndex > 0) {
                val prevId = entryIds[currentIndex - 1]
                viewModelScope.launch {
                    entryRepository.preloadEntry(prevId)
                }
                // Observe the entry from database and update state when available
                viewModelScope.launch {
                    entryRepository.getEntryFlow(prevId).collect { entry ->
                        if (entry != null && hasFullContent(entry)) {
                            _swipeNavState.value = _swipeNavState.value.copy(previousEntry = entry)
                        }
                    }
                }
            }

            // Preload and observe next entry
            if (currentIndex >= 0 && currentIndex < entryIds.size - 1) {
                val nextId = entryIds[currentIndex + 1]
                viewModelScope.launch {
                    entryRepository.preloadEntry(nextId)
                }
                // Observe the entry from database and update state when available
                viewModelScope.launch {
                    entryRepository.getEntryFlow(nextId).collect { entry ->
                        if (entry != null && hasFullContent(entry)) {
                            _swipeNavState.value = _swipeNavState.value.copy(nextEntry = entry)
                        }
                    }
                }
            }
        }

        /**
         * Checks if an entry has full content (not just a summary from the list endpoint).
         */
        private fun hasFullContent(entry: EntryWithState): Boolean =
            entry.entry.contentOriginal != null || entry.entry.contentCleaned != null

        /**
         * Loads the entry from local storage or fetches from the server.
         *
         * First attempts to load from the local database. If not found,
         * fetches from the server and stores locally.
         */
        private fun loadEntry() {
            viewModelScope.launch {
                _uiState.value = _uiState.value.copy(isLoading = true, errorMessage = null)

                // Observe the entry from local database
                entryRepository.getEntryFlow(entryId).collect { entryWithState ->
                    if (entryWithState != null) {
                        _entry.value = entryWithState
                        _uiState.value =
                            _uiState.value.copy(
                                isLoading = false,
                                entry = entryWithState,
                            )
                    }
                }
            }

            // Also try to fetch from server if not in local DB
            viewModelScope.launch {
                when (val result = entryRepository.getEntry(entryId)) {
                    is EntryFetchResult.Success -> {
                        // Entry is now in local DB, will be picked up by the flow above
                        // Mark as read after successful load
                        markAsRead()
                    }
                    is EntryFetchResult.NotFound -> {
                        if (_entry.value == null) {
                            _uiState.value =
                                _uiState.value.copy(
                                    isLoading = false,
                                    errorMessage = "Entry not found",
                                )
                        }
                    }
                    is EntryFetchResult.Error -> {
                        if (_entry.value == null) {
                            _uiState.value =
                                _uiState.value.copy(
                                    isLoading = false,
                                    errorMessage = result.message,
                                )
                        }
                    }
                    is EntryFetchResult.NetworkError -> {
                        if (_entry.value == null) {
                            _uiState.value =
                                _uiState.value.copy(
                                    isLoading = false,
                                    errorMessage = "Network error. Please check your connection.",
                                )
                        }
                    }
                }
            }
        }

        /**
         * Marks the current entry as read.
         *
         * Called automatically when the entry is viewed.
         */
        fun markAsRead() {
            if (entryId.isEmpty()) return

            viewModelScope.launch {
                entryRepository.markRead(entryId, read = true)
            }
        }

        /**
         * Toggles the starred status of the current entry.
         */
        fun toggleStar() {
            if (entryId.isEmpty()) return

            viewModelScope.launch {
                entryRepository.toggleStarred(entryId)
            }
        }

        /**
         * Emits a share event for the Activity to handle.
         *
         * @param url The URL to share
         */
        fun share(url: String) {
            val title = _entry.value?.entry?.title ?: "Article"
            viewModelScope.launch {
                _events.send(EntryDetailEvent.Share(url = url, title = title))
            }
        }

        /**
         * Emits an open in browser event for the Activity to handle.
         *
         * @param url The URL to open
         */
        fun openInBrowser(url: String) {
            viewModelScope.launch {
                _events.send(EntryDetailEvent.OpenInBrowser(url = url))
            }
        }

        /**
         * Clears any error message being displayed.
         */
        fun clearError() {
            _uiState.value = _uiState.value.copy(errorMessage = null)
        }

        /**
         * Refreshes the entry from the server.
         */
        fun refresh() {
            loadEntry()
        }

        /**
         * Retries loading the entry after an error.
         *
         * Clears the error state and attempts to reload the entry.
         */
        fun retry() {
            _uiState.value = _uiState.value.copy(errorMessage = null)
            loadEntry()
        }
    }
