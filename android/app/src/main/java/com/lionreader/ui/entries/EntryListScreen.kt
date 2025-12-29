package com.lionreader.ui.entries

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
import androidx.compose.material.icons.filled.ArrowDownward
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.Menu
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
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.lionreader.data.api.models.SortOrder
import com.lionreader.data.db.relations.EntryWithState
import com.lionreader.ui.components.ConnectivitySnackbarEffect
import com.lionreader.ui.components.EntryListEmptyState
import com.lionreader.ui.components.EntryListSkeleton
import com.lionreader.ui.components.OfflineBanner
import com.lionreader.ui.components.OfflineIcon
import kotlinx.coroutines.launch

/**
 * Entry list screen composable.
 *
 * Displays a list of entries with filtering, sorting, pull-to-refresh,
 * and infinite scroll capabilities. Shows offline indicator when not
 * connected to the network.
 *
 * @param currentRoute The current navigation route determining which entries to show
 * @param onEntryClick Callback when an entry is clicked for navigation to detail
 * @param onDrawerOpen Callback to open the navigation drawer
 * @param viewModel ViewModel managing the entry list state
 * @param modifier Modifier for the screen
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EntryListScreen(
    currentRoute: String,
    onEntryClick: (String) -> Unit,
    onDrawerOpen: () -> Unit,
    viewModel: EntryListViewModel = hiltViewModel(),
    modifier: Modifier = Modifier,
) {
    val uiState by viewModel.uiState.collectAsStateWithLifecycle()
    val entries by viewModel.entries.collectAsStateWithLifecycle()

    val snackbarHostState = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()

    // Update ViewModel when route changes
    LaunchedEffect(currentRoute) {
        viewModel.setRoute(currentRoute)
    }

    // Show error message in snackbar
    LaunchedEffect(uiState.errorMessage) {
        uiState.errorMessage?.let { message ->
            scope.launch {
                snackbarHostState.showSnackbar(message)
                viewModel.clearError()
            }
        }
    }

    // Handle connectivity changes with snackbar notifications
    ConnectivitySnackbarEffect(
        isOnline = uiState.isOnline,
        snackbarHostState = snackbarHostState,
        onSyncRequested = viewModel::refresh,
    )

    Scaffold(
        modifier = modifier,
        topBar = {
            EntryListTopBar(
                title = uiState.title,
                isOnline = uiState.isOnline,
                unreadOnly = uiState.unreadOnly,
                sortOrder = uiState.sortOrder,
                onDrawerOpen = onDrawerOpen,
                onToggleUnreadOnly = viewModel::toggleUnreadOnly,
                onToggleSortOrder = viewModel::toggleSortOrder,
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
            // Offline banner at the top
            OfflineBanner(isOnline = uiState.isOnline)

            // Main content
            EntryListContent(
                entries = entries,
                uiState = uiState,
                onEntryClick = onEntryClick,
                onToggleRead = viewModel::toggleRead,
                onToggleStar = viewModel::toggleStar,
                onRefresh = viewModel::refresh,
                onLoadMore = viewModel::loadMore,
                onShowAll = if (uiState.unreadOnly) viewModel::toggleUnreadOnly else null,
                modifier =
                    Modifier
                        .fillMaxSize()
                        .weight(1f),
            )
        }
    }
}

/**
 * Top app bar for the entry list screen.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun EntryListTopBar(
    title: String,
    isOnline: Boolean,
    unreadOnly: Boolean,
    sortOrder: SortOrder,
    onDrawerOpen: () -> Unit,
    onToggleUnreadOnly: () -> Unit,
    onToggleSortOrder: () -> Unit,
) {
    TopAppBar(
        title = { Text(text = title) },
        navigationIcon = {
            IconButton(onClick = onDrawerOpen) {
                Icon(
                    imageVector = Icons.Default.Menu,
                    contentDescription = "Open navigation drawer",
                )
            }
        },
        actions = {
            // Offline indicator
            OfflineIcon(isOnline = isOnline)

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
                            "Showing all entries"
                        },
                    tint =
                        if (unreadOnly) {
                            MaterialTheme.colorScheme.primary
                        } else {
                            MaterialTheme.colorScheme.onSurfaceVariant
                        },
                )
            }

            // Sort order toggle
            IconButton(onClick = onToggleSortOrder) {
                Icon(
                    imageVector =
                        if (sortOrder == SortOrder.NEWEST) {
                            Icons.Default.ArrowDownward
                        } else {
                            Icons.Default.ArrowUpward
                        },
                    contentDescription =
                        if (sortOrder == SortOrder.NEWEST) {
                            "Sorted by newest first"
                        } else {
                            "Sorted by oldest first"
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
 * Main content of the entry list screen.
 *
 * Handles loading, empty, error, and normal states with pull-to-refresh
 * and infinite scroll.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun EntryListContent(
    entries: List<EntryWithState>,
    uiState: EntryListUiState,
    onEntryClick: (String) -> Unit,
    onToggleRead: (String) -> Unit,
    onToggleStar: (String) -> Unit,
    onRefresh: () -> Unit,
    onLoadMore: () -> Unit,
    onShowAll: (() -> Unit)?,
    modifier: Modifier = Modifier,
) {
    val pullToRefreshState = rememberPullToRefreshState()

    // Determine if this is a starred-only view based on title
    val isStarredOnly = uiState.title == "Starred"

    PullToRefreshBox(
        isRefreshing = uiState.isRefreshing,
        onRefresh = onRefresh,
        state = pullToRefreshState,
        modifier = modifier,
    ) {
        when {
            // Initial loading state - show skeleton
            uiState.isLoading && entries.isEmpty() -> {
                EntryListSkeleton()
            }

            // Empty state - use contextual empty state component
            entries.isEmpty() -> {
                EntryListEmptyState(
                    isUnreadOnly = uiState.unreadOnly,
                    isStarredOnly = isStarredOnly,
                    isOnline = uiState.isOnline,
                    hasFeedsSubscribed = true, // Assume true, would need feed count from ViewModel
                    onShowAll = onShowAll,
                )
            }

            // Normal state with entries
            else -> {
                EntryList(
                    entries = entries,
                    hasMore = uiState.hasMore,
                    isLoadingMore = uiState.isLoadingMore,
                    onEntryClick = onEntryClick,
                    onToggleRead = onToggleRead,
                    onToggleStar = onToggleStar,
                    onLoadMore = onLoadMore,
                )
            }
        }
    }
}

/**
 * Entry list with infinite scroll.
 */
@Composable
private fun EntryList(
    entries: List<EntryWithState>,
    hasMore: Boolean,
    isLoadingMore: Boolean,
    onEntryClick: (String) -> Unit,
    onToggleRead: (String) -> Unit,
    onToggleStar: (String) -> Unit,
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
            // Load more when we're within 5 items of the end
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
            items = entries,
            key = { it.entry.id },
        ) { entry ->
            EntryListItem(
                entry = entry,
                onClick = { onEntryClick(entry.entry.id) },
                onToggleRead = { onToggleRead(entry.entry.id) },
                onToggleStar = { onToggleStar(entry.entry.id) },
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
