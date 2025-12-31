package com.lionreader.ui.saved

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.lionreader.data.api.models.EntryDto
import com.lionreader.data.repository.SavedArticleFetchResult
import com.lionreader.data.repository.SavedArticleRepository
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
 * UI state for the saved article detail screen.
 */
data class SavedArticleDetailUiState(
    val isLoading: Boolean = true,
    val errorMessage: String? = null,
)

/**
 * Events emitted by the ViewModel that require Activity handling.
 */
sealed class SavedArticleDetailEvent {
    /**
     * Request to share the article URL and title.
     */
    data class Share(
        val url: String,
        val title: String,
    ) : SavedArticleDetailEvent()

    /**
     * Request to open the article URL in an external browser.
     */
    data class OpenInBrowser(
        val url: String,
    ) : SavedArticleDetailEvent()
}

/**
 * ViewModel for the saved article detail screen.
 *
 * Manages article loading, read/star state, and actions like sharing
 * and opening in browser.
 *
 * @param savedStateHandle Used to retrieve the article ID from navigation arguments
 * @param savedArticleRepository Repository for saved article operations
 */
@HiltViewModel
class SavedArticleDetailViewModel
    @Inject
    constructor(
        private val savedStateHandle: SavedStateHandle,
        private val savedArticleRepository: SavedArticleRepository,
    ) : ViewModel() {
        /**
         * The saved article ID retrieved from navigation arguments.
         */
        private val articleId: String =
            savedStateHandle.get<String>(Screen.ARG_SAVED_ARTICLE_ID) ?: ""

        /**
         * UI state for the saved article detail screen.
         */
        private val _uiState = MutableStateFlow(SavedArticleDetailUiState())
        val uiState: StateFlow<SavedArticleDetailUiState> = _uiState.asStateFlow()

        /**
         * Current saved article.
         */
        private val _article = MutableStateFlow<EntryDto?>(null)
        val article: StateFlow<EntryDto?> = _article.asStateFlow()

        /**
         * Channel for one-shot events that need Activity handling.
         */
        private val _events = Channel<SavedArticleDetailEvent>(Channel.BUFFERED)
        val events = _events.receiveAsFlow()

        init {
            if (articleId.isNotEmpty()) {
                loadArticle()
            } else {
                _uiState.value =
                    SavedArticleDetailUiState(
                        isLoading = false,
                        errorMessage = "Invalid article ID",
                    )
            }
        }

        /**
         * Loads the saved article from the server.
         */
        private fun loadArticle() {
            viewModelScope.launch {
                _uiState.value = _uiState.value.copy(isLoading = true, errorMessage = null)

                when (val result = savedArticleRepository.getSavedArticle(articleId)) {
                    is SavedArticleFetchResult.Success -> {
                        _article.value = result.article
                        _uiState.value = _uiState.value.copy(isLoading = false)
                        // Mark as read after successful load
                        markAsRead()
                    }
                    is SavedArticleFetchResult.NotFound -> {
                        _uiState.value =
                            _uiState.value.copy(
                                isLoading = false,
                                errorMessage = "Article not found",
                            )
                    }
                    is SavedArticleFetchResult.Error -> {
                        _uiState.value =
                            _uiState.value.copy(
                                isLoading = false,
                                errorMessage = result.message,
                            )
                    }
                    is SavedArticleFetchResult.NetworkError -> {
                        _uiState.value =
                            _uiState.value.copy(
                                isLoading = false,
                                errorMessage = "Network error. Please check your connection.",
                            )
                    }
                    is SavedArticleFetchResult.Unauthorized -> {
                        _uiState.value =
                            _uiState.value.copy(
                                isLoading = false,
                                errorMessage = "Session expired. Please log in again.",
                            )
                    }
                }
            }
        }

        /**
         * Marks the current article as read.
         */
        private fun markAsRead() {
            if (articleId.isEmpty()) return

            viewModelScope.launch {
                savedArticleRepository.markRead(listOf(articleId), read = true)
                // Update local state
                _article.value = _article.value?.copy(read = true)
            }
        }

        /**
         * Toggles the starred status of the current article.
         */
        fun toggleStar() {
            val currentArticle = _article.value ?: return
            val newStarredStatus = !currentArticle.starred

            // Optimistic update
            _article.value = currentArticle.copy(starred = newStarredStatus)

            viewModelScope.launch {
                val success = savedArticleRepository.toggleStarred(articleId, !newStarredStatus)
                if (!success) {
                    // Revert on failure
                    _article.value = _article.value?.copy(starred = !newStarredStatus)
                    _uiState.value = _uiState.value.copy(errorMessage = "Failed to update starred status")
                }
            }
        }

        /**
         * Emits a share event for the Activity to handle.
         *
         * @param url The URL to share
         */
        fun share(url: String) {
            val title = _article.value?.title ?: "Article"
            viewModelScope.launch {
                _events.send(SavedArticleDetailEvent.Share(url = url, title = title))
            }
        }

        /**
         * Emits an open in browser event for the Activity to handle.
         *
         * @param url The URL to open
         */
        fun openInBrowser(url: String) {
            viewModelScope.launch {
                _events.send(SavedArticleDetailEvent.OpenInBrowser(url = url))
            }
        }

        /**
         * Clears any error message being displayed.
         */
        fun clearError() {
            _uiState.value = _uiState.value.copy(errorMessage = null)
        }

        /**
         * Retries loading the article after an error.
         */
        fun retry() {
            _uiState.value = _uiState.value.copy(errorMessage = null)
            loadArticle()
        }
    }
