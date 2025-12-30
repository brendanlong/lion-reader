package com.lionreader.ui.saved

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.pulltorefresh.rememberPullToRefreshState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.lionreader.data.api.models.SavedArticleListItemDto
import kotlinx.coroutines.launch

/**
 * Saved articles list screen composable.
 *
 * Displays a list of saved articles with filtering, pull-to-refresh,
 * and infinite scroll capabilities.
 *
 * @param onArticleClick Callback when an article is clicked for navigation to detail
 * @param onBack Callback when back navigation is requested
 * @param viewModel ViewModel managing the saved articles state
 * @param modifier Modifier for the screen
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SavedArticlesListScreen(
    onArticleClick: (String) -> Unit,
    onBack: () -> Unit,
    viewModel: SavedArticlesViewModel = hiltViewModel(),
    modifier: Modifier = Modifier,
) {
    val uiState by viewModel.uiState.collectAsStateWithLifecycle()
    val articles by viewModel.articles.collectAsStateWithLifecycle()

    val snackbarHostState = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()

    // Show error message in snackbar
    LaunchedEffect(uiState.errorMessage) {
        uiState.errorMessage?.let { message ->
            scope.launch {
                snackbarHostState.showSnackbar(message)
                viewModel.clearError()
            }
        }
    }

    Scaffold(
        modifier = modifier,
        topBar = {
            SavedArticlesTopBar(
                title = uiState.title,
                unreadOnly = uiState.unreadOnly,
                onBack = onBack,
                onToggleUnreadOnly = viewModel::toggleUnreadOnly,
            )
        },
        snackbarHost = {
            SnackbarHost(hostState = snackbarHostState) { data ->
                Snackbar(snackbarData = data)
            }
        },
    ) { padding ->
        Column(
            modifier =
                Modifier
                    .fillMaxSize()
                    .padding(padding),
        ) {
            SavedArticlesContent(
                articles = articles,
                uiState = uiState,
                onArticleClick = onArticleClick,
                onToggleRead = viewModel::toggleRead,
                onToggleStar = viewModel::toggleStar,
                onDelete = viewModel::deleteArticle,
                onRefresh = viewModel::refresh,
                onLoadMore = viewModel::loadMore,
                onShowAll = if (uiState.unreadOnly) viewModel::toggleUnreadOnly else null,
                modifier = Modifier.fillMaxSize(),
            )
        }
    }
}

/**
 * Top app bar for the saved articles screen.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SavedArticlesTopBar(
    title: String,
    unreadOnly: Boolean,
    onBack: () -> Unit,
    onToggleUnreadOnly: () -> Unit,
) {
    TopAppBar(
        title = { Text(text = title) },
        navigationIcon = {
            IconButton(onClick = onBack) {
                Icon(
                    imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                    contentDescription = "Go back",
                )
            }
        },
        actions = {
            // Unread filter toggle
            IconButton(onClick = onToggleUnreadOnly) {
                Icon(
                    imageVector =
                        if (unreadOnly) {
                            Icons.Default.Visibility
                        } else {
                            Icons.Default.VisibilityOff
                        },
                    contentDescription =
                        if (unreadOnly) {
                            "Showing unread only"
                        } else {
                            "Showing all articles"
                        },
                    tint =
                        if (unreadOnly) {
                            MaterialTheme.colorScheme.primary
                        } else {
                            MaterialTheme.colorScheme.onSurfaceVariant
                        },
                )
            }
        },
        colors =
            TopAppBarDefaults.topAppBarColors(
                containerColor = MaterialTheme.colorScheme.surface,
                titleContentColor = MaterialTheme.colorScheme.onSurface,
            ),
    )
}

/**
 * Main content of the saved articles screen.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SavedArticlesContent(
    articles: List<SavedArticleListItemDto>,
    uiState: SavedArticlesUiState,
    onArticleClick: (String) -> Unit,
    onToggleRead: (String) -> Unit,
    onToggleStar: (String) -> Unit,
    onDelete: (String) -> Unit,
    onRefresh: () -> Unit,
    onLoadMore: () -> Unit,
    onShowAll: (() -> Unit)?,
    modifier: Modifier = Modifier,
) {
    val pullToRefreshState = rememberPullToRefreshState()

    PullToRefreshBox(
        isRefreshing = uiState.isRefreshing,
        onRefresh = onRefresh,
        state = pullToRefreshState,
        modifier = modifier,
    ) {
        when {
            // Initial loading state
            uiState.isLoading && articles.isEmpty() -> {
                Box(
                    modifier = Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator()
                }
            }

            // Empty state
            articles.isEmpty() -> {
                SavedArticlesEmptyState(
                    isUnreadOnly = uiState.unreadOnly,
                    onShowAll = onShowAll,
                )
            }

            // Normal state with articles
            else -> {
                SavedArticlesList(
                    articles = articles,
                    hasMore = uiState.hasMore,
                    isLoadingMore = uiState.isLoadingMore,
                    onArticleClick = onArticleClick,
                    onToggleRead = onToggleRead,
                    onToggleStar = onToggleStar,
                    onDelete = onDelete,
                    onLoadMore = onLoadMore,
                )
            }
        }
    }
}

/**
 * Saved articles list with infinite scroll.
 */
@Composable
private fun SavedArticlesList(
    articles: List<SavedArticleListItemDto>,
    hasMore: Boolean,
    isLoadingMore: Boolean,
    onArticleClick: (String) -> Unit,
    onToggleRead: (String) -> Unit,
    onToggleStar: (String) -> Unit,
    onDelete: (String) -> Unit,
    onLoadMore: () -> Unit,
) {
    val listState = rememberLazyListState()

    // Detect when near the end of the list for infinite scroll
    val shouldLoadMore by remember {
        derivedStateOf {
            val lastVisibleItemIndex =
                listState.layoutInfo.visibleItemsInfo
                    .lastOrNull()
                    ?.index ?: 0
            val totalItemsCount = listState.layoutInfo.totalItemsCount
            lastVisibleItemIndex >= totalItemsCount - 5 && totalItemsCount > 0
        }
    }

    // Trigger load more when approaching end of list
    LaunchedEffect(shouldLoadMore, hasMore, isLoadingMore) {
        if (shouldLoadMore && hasMore && !isLoadingMore) {
            onLoadMore()
        }
    }

    LazyColumn(
        state = listState,
        contentPadding = PaddingValues(vertical = 8.dp),
        modifier = Modifier.fillMaxSize(),
    ) {
        items(
            items = articles,
            key = { it.id },
        ) { article ->
            SavedArticleListItem(
                article = article,
                onClick = { onArticleClick(article.id) },
                onToggleRead = { onToggleRead(article.id) },
                onToggleStar = { onToggleStar(article.id) },
                onDelete = { onDelete(article.id) },
            )
        }

        // Loading more indicator at the bottom
        if (hasMore || isLoadingMore) {
            item {
                Box(
                    modifier =
                        Modifier
                            .fillMaxWidth()
                            .padding(16.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(24.dp),
                        strokeWidth = 2.dp,
                    )
                }
            }
        }
    }
}

/**
 * Empty state for the saved articles list.
 */
@Composable
private fun SavedArticlesEmptyState(
    isUnreadOnly: Boolean,
    onShowAll: (() -> Unit)?,
) {
    Box(
        modifier = Modifier.fillMaxSize(),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier.padding(32.dp),
        ) {
            Text(
                text =
                    if (isUnreadOnly) {
                        "No unread saved articles"
                    } else {
                        "No saved articles yet"
                    },
                style = MaterialTheme.typography.titleMedium,
                textAlign = TextAlign.Center,
            )
            Text(
                text =
                    if (isUnreadOnly) {
                        "All your saved articles have been read."
                    } else {
                        "Share articles from your browser or other apps to save them here for later reading."
                    },
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(top = 8.dp),
            )
            if (isUnreadOnly && onShowAll != null) {
                androidx.compose.material3.TextButton(
                    onClick = onShowAll,
                    modifier = Modifier.padding(top = 16.dp),
                ) {
                    Text("Show all articles")
                }
            }
        }
    }
}
