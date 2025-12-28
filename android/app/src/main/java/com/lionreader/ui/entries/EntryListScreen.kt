package com.lionreader.ui.entries

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDownward
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.CloudOff
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
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.lionreader.data.api.models.SortOrder
import com.lionreader.data.db.relations.EntryWithState
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
        EntryListContent(
            entries = entries,
            uiState = uiState,
            onEntryClick = onEntryClick,
            onToggleRead = viewModel::toggleRead,
            onToggleStar = viewModel::toggleStar,
            onRefresh = viewModel::refresh,
            onLoadMore = viewModel::loadMore,
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        )
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
            if (!isOnline) {
                Icon(
                    imageVector = Icons.Default.CloudOff,
                    contentDescription = "Offline",
                    tint = MaterialTheme.colorScheme.error,
                    modifier = Modifier.padding(horizontal = 8.dp),
                )
            }

            // Unread filter toggle
            IconButton(onClick = onToggleUnreadOnly) {
                Icon(
                    imageVector = if (unreadOnly) {
                        Icons.Default.Visibility
                    } else {
                        Icons.Default.VisibilityOff
                    },
                    contentDescription = if (unreadOnly) {
                        "Showing unread only"
                    } else {
                        "Showing all entries"
                    },
                    tint = if (unreadOnly) {
                        MaterialTheme.colorScheme.primary
                    } else {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    },
                )
            }

            // Sort order toggle
            IconButton(onClick = onToggleSortOrder) {
                Icon(
                    imageVector = if (sortOrder == SortOrder.NEWEST) {
                        Icons.Default.ArrowDownward
                    } else {
                        Icons.Default.ArrowUpward
                    },
                    contentDescription = if (sortOrder == SortOrder.NEWEST) {
                        "Sorted by newest first"
                    } else {
                        "Sorted by oldest first"
                    },
                )
            }
        },
        colors = TopAppBarDefaults.topAppBarColors(
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
            uiState.isLoading && entries.isEmpty() -> {
                LoadingState()
            }

            // Empty state
            entries.isEmpty() -> {
                EmptyState(
                    unreadOnly = uiState.unreadOnly,
                    isOnline = uiState.isOnline,
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
            val lastVisibleItemIndex = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
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
                    modifier = Modifier
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
 * Loading state displayed when entries are being fetched.
 */
@Composable
private fun LoadingState() {
    Box(
        modifier = Modifier.fillMaxSize(),
        contentAlignment = Alignment.Center,
    ) {
        CircularProgressIndicator()
    }
}

/**
 * Empty state displayed when there are no entries.
 */
@Composable
private fun EmptyState(
    unreadOnly: Boolean,
    isOnline: Boolean,
) {
    Box(
        modifier = Modifier.fillMaxSize(),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
            modifier = Modifier.padding(32.dp),
        ) {
            Text(
                text = if (unreadOnly) "All caught up!" else "No entries",
                style = MaterialTheme.typography.headlineSmall,
                textAlign = TextAlign.Center,
            )

            Spacer(modifier = Modifier.height(8.dp))

            Text(
                text = when {
                    !isOnline -> "You're offline. Pull down to refresh when connected."
                    unreadOnly -> "You've read all your entries. Try showing all entries."
                    else -> "No entries in this view yet."
                },
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
        }
    }
}
