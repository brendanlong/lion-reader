package com.lionreader.ui.entries

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.lionreader.data.db.relations.EntryWithState
import com.lionreader.data.repository.EntryFetchResult
import com.lionreader.data.repository.EntryRepository
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
    ) : ViewModel() {
        /**
         * The entry ID retrieved from navigation arguments.
         */
        private val entryId: String = savedStateHandle.get<String>(Screen.ARG_ENTRY_ID) ?: ""

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
         * Channel for one-shot events that need Activity handling.
         */
        private val _events = Channel<EntryDetailEvent>(Channel.BUFFERED)
        val events = _events.receiveAsFlow()

        init {
            if (entryId.isNotEmpty()) {
                loadEntry()
            } else {
                _uiState.value =
                    EntryDetailUiState(
                        isLoading = false,
                        errorMessage = "Invalid entry ID",
                    )
            }
        }

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
