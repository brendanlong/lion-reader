package com.lionreader.ui.saved

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.lionreader.data.api.models.SavedArticleListItemDto
import com.lionreader.data.repository.SavedArticleFilters
import com.lionreader.data.repository.SavedArticleRepository
import com.lionreader.data.repository.SavedArticlesResult
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * ViewModel for the saved articles list screen.
 *
 * Manages the list of saved articles with pagination and actions.
 *
 * @param savedArticleRepository Repository for saved article operations
 */
@HiltViewModel
class SavedArticlesViewModel
    @Inject
    constructor(
        private val savedArticleRepository: SavedArticleRepository,
    ) : ViewModel() {
        companion object {
            private const val PAGE_SIZE = 50
        }

        // UI state
        private val _uiState = MutableStateFlow(SavedArticlesUiState())
        val uiState: StateFlow<SavedArticlesUiState> = _uiState.asStateFlow()

        // Articles list
        private val _articles = MutableStateFlow<List<SavedArticleListItemDto>>(emptyList())
        val articles: StateFlow<List<SavedArticleListItemDto>> = _articles.asStateFlow()

        // Pagination
        private var nextCursor: String? = null
        private var isLoadingMore = false

        init {
            loadArticles()
        }

        /**
         * Loads the initial list of saved articles.
         */
        private fun loadArticles() {
            viewModelScope.launch {
                _uiState.update { it.copy(isLoading = true, errorMessage = null) }

                val result =
                    savedArticleRepository.listSavedArticles(
                        filters =
                            SavedArticleFilters(
                                unreadOnly = _uiState.value.unreadOnly,
                                limit = PAGE_SIZE,
                            ),
                    )

                when (result) {
                    is SavedArticlesResult.Success -> {
                        _articles.value = result.articles
                        nextCursor = result.nextCursor
                        _uiState.update {
                            it.copy(
                                isLoading = false,
                                hasMore = result.nextCursor != null,
                            )
                        }
                    }
                    is SavedArticlesResult.Error -> {
                        _uiState.update {
                            it.copy(
                                isLoading = false,
                                errorMessage = result.message,
                            )
                        }
                    }
                    is SavedArticlesResult.NetworkError -> {
                        _uiState.update {
                            it.copy(
                                isLoading = false,
                                errorMessage = "Network error. Please check your connection.",
                            )
                        }
                    }
                    is SavedArticlesResult.Unauthorized -> {
                        _uiState.update {
                            it.copy(
                                isLoading = false,
                                errorMessage = "Session expired. Please log in again.",
                            )
                        }
                    }
                }
            }
        }

        /**
         * Refreshes the list of saved articles (pull-to-refresh).
         */
        fun refresh() {
            viewModelScope.launch {
                _uiState.update { it.copy(isRefreshing = true, errorMessage = null) }

                val result =
                    savedArticleRepository.listSavedArticles(
                        filters =
                            SavedArticleFilters(
                                unreadOnly = _uiState.value.unreadOnly,
                                limit = PAGE_SIZE,
                            ),
                    )

                when (result) {
                    is SavedArticlesResult.Success -> {
                        _articles.value = result.articles
                        nextCursor = result.nextCursor
                        _uiState.update {
                            it.copy(
                                isRefreshing = false,
                                hasMore = result.nextCursor != null,
                            )
                        }
                    }
                    is SavedArticlesResult.Error -> {
                        _uiState.update {
                            it.copy(
                                isRefreshing = false,
                                errorMessage = result.message,
                            )
                        }
                    }
                    is SavedArticlesResult.NetworkError -> {
                        _uiState.update {
                            it.copy(
                                isRefreshing = false,
                                errorMessage = "Network error. Please check your connection.",
                            )
                        }
                    }
                    is SavedArticlesResult.Unauthorized -> {
                        _uiState.update {
                            it.copy(
                                isRefreshing = false,
                                errorMessage = "Session expired. Please log in again.",
                            )
                        }
                    }
                }
            }
        }

        /**
         * Loads more articles for infinite scroll.
         */
        fun loadMore() {
            val cursor = nextCursor
            if (isLoadingMore || cursor == null) return

            viewModelScope.launch {
                isLoadingMore = true
                _uiState.update { it.copy(isLoadingMore = true) }

                val result =
                    savedArticleRepository.listSavedArticles(
                        filters =
                            SavedArticleFilters(
                                unreadOnly = _uiState.value.unreadOnly,
                                limit = PAGE_SIZE,
                            ),
                        cursor = cursor,
                    )

                when (result) {
                    is SavedArticlesResult.Success -> {
                        _articles.value = _articles.value + result.articles
                        nextCursor = result.nextCursor
                        _uiState.update {
                            it.copy(
                                isLoadingMore = false,
                                hasMore = result.nextCursor != null,
                            )
                        }
                    }
                    is SavedArticlesResult.Error -> {
                        _uiState.update {
                            it.copy(
                                isLoadingMore = false,
                                errorMessage = result.message,
                            )
                        }
                    }
                    else -> {
                        _uiState.update { it.copy(isLoadingMore = false) }
                    }
                }

                isLoadingMore = false
            }
        }

        /**
         * Toggles the unread-only filter.
         */
        fun toggleUnreadOnly() {
            val newValue = !_uiState.value.unreadOnly
            _uiState.update { it.copy(unreadOnly = newValue) }
            nextCursor = null
            loadArticles()
        }

        /**
         * Toggles the read status of an article.
         */
        fun toggleRead(articleId: String) {
            val article = _articles.value.find { it.id == articleId } ?: return
            val newReadStatus = !article.read

            // Optimistic update
            _articles.value =
                _articles.value.map {
                    if (it.id == articleId) it.copy(read = newReadStatus) else it
                }

            viewModelScope.launch {
                val success = savedArticleRepository.markRead(listOf(articleId), newReadStatus)
                if (!success) {
                    // Revert on failure
                    _articles.value =
                        _articles.value.map {
                            if (it.id == articleId) it.copy(read = !newReadStatus) else it
                        }
                    _uiState.update { it.copy(errorMessage = "Failed to update read status") }
                }
            }
        }

        /**
         * Toggles the starred status of an article.
         */
        fun toggleStar(articleId: String) {
            val article = _articles.value.find { it.id == articleId } ?: return
            val newStarredStatus = !article.starred

            // Optimistic update
            _articles.value =
                _articles.value.map {
                    if (it.id == articleId) it.copy(starred = newStarredStatus) else it
                }

            viewModelScope.launch {
                val success = savedArticleRepository.toggleStarred(articleId, !newStarredStatus)
                if (!success) {
                    // Revert on failure
                    _articles.value =
                        _articles.value.map {
                            if (it.id == articleId) it.copy(starred = !newStarredStatus) else it
                        }
                    _uiState.update { it.copy(errorMessage = "Failed to update starred status") }
                }
            }
        }

        /**
         * Deletes a saved article.
         */
        fun deleteArticle(articleId: String) {
            val articleToDelete = _articles.value.find { it.id == articleId } ?: return

            // Optimistic update
            _articles.value = _articles.value.filter { it.id != articleId }

            viewModelScope.launch {
                val success = savedArticleRepository.deleteSavedArticle(articleId)
                if (!success) {
                    // Revert on failure
                    _articles.value = _articles.value + articleToDelete
                    _uiState.update { it.copy(errorMessage = "Failed to delete article") }
                }
            }
        }

        /**
         * Clears any error message being displayed.
         */
        fun clearError() {
            _uiState.update { it.copy(errorMessage = null) }
        }
    }
