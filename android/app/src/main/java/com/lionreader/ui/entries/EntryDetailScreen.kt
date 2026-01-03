package com.lionreader.ui.entries

import android.content.Intent
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.OpenInBrowser
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.outlined.StarBorder
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
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.lionreader.data.db.relations.EntryWithState
import com.lionreader.ui.components.EntryDetailSkeleton
import com.lionreader.ui.components.ErrorState
import com.lionreader.ui.components.ErrorType
import com.lionreader.ui.narration.NarrationControls
import com.lionreader.ui.narration.NarrationViewModel
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Entry detail screen displaying full article content with swipe navigation.
 *
 * Shows the complete article with header (feed name, title, author, date),
 * HTML content rendered in a WebView, and action buttons for starring,
 * sharing, and opening in browser.
 *
 * Supports swiping left/right to navigate to adjacent entries when the
 * list context is available.
 *
 * @param onBack Callback when back navigation is triggered
 * @param onNavigateToEntry Callback when navigating to a different entry via swipe.
 *                          Parameters: (entryId, listContext)
 * @param viewModel ViewModel managing the entry detail state
 * @param modifier Modifier for the screen
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EntryDetailScreen(
    onBack: () -> Unit,
    onNavigateToEntry: (entryId: String, listContext: String?) -> Unit = { _, _ -> },
    viewModel: EntryDetailViewModel = hiltViewModel(),
    narrationViewModel: NarrationViewModel = hiltViewModel(),
    modifier: Modifier = Modifier,
) {
    val uiState by viewModel.uiState.collectAsStateWithLifecycle()
    val entry by viewModel.entry.collectAsStateWithLifecycle()
    val swipeNavState by viewModel.swipeNavState.collectAsStateWithLifecycle()
    val narrationState by narrationViewModel.narrationState.collectAsStateWithLifecycle()
    val snackbarHostState = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current

    // Handle one-shot events from the ViewModel
    LaunchedEffect(Unit) {
        viewModel.events.collect { event ->
            when (event) {
                is EntryDetailEvent.Share -> {
                    val shareIntent =
                        Intent(Intent.ACTION_SEND).apply {
                            type = "text/plain"
                            putExtra(Intent.EXTRA_SUBJECT, event.title)
                            putExtra(Intent.EXTRA_TEXT, "${event.title}\n${event.url}")
                        }
                    context.startActivity(
                        Intent.createChooser(shareIntent, "Share article"),
                    )
                }
                is EntryDetailEvent.OpenInBrowser -> {
                    try {
                        val browserIntent = Intent(Intent.ACTION_VIEW, Uri.parse(event.url))
                        context.startActivity(browserIntent)
                    } catch (e: Exception) {
                        scope.launch {
                            snackbarHostState.showSnackbar("Could not open browser")
                        }
                    }
                }
            }
        }
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

    // Handle system back gesture to ensure proper navigation back to the originating list
    BackHandler(onBack = onBack)

    Scaffold(
        modifier = modifier,
        topBar = {
            EntryDetailTopBar(
                entry = entry,
                onBack = onBack,
                onToggleStar = viewModel::toggleStar,
                onShare = { entry?.entry?.url?.let { viewModel.share(it) } },
                onOpenInBrowser = { entry?.entry?.url?.let { viewModel.openInBrowser(it) } },
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
            // Main content
            Box(
                modifier =
                    Modifier
                        .weight(1f)
                        .fillMaxWidth(),
            ) {
                // Use swipeable pager when we have navigation context
                if (swipeNavState.entryIds.isNotEmpty() && swipeNavState.currentIndex >= 0) {
                    SwipeableEntryPager(
                        entryIds = swipeNavState.entryIds,
                        currentIndex = swipeNavState.currentIndex,
                        listContext = swipeNavState.listContext,
                        currentEntry = entry,
                        previousEntry = swipeNavState.previousEntry,
                        nextEntry = swipeNavState.nextEntry,
                        isLoading = uiState.isLoading,
                        errorMessage = uiState.errorMessage,
                        onNavigateToEntry = onNavigateToEntry,
                        onLinkClick = { url -> viewModel.openInBrowser(url) },
                        onRetry = { viewModel.retry() },
                        modifier = Modifier.fillMaxSize(),
                    )
                } else {
                    // Fallback to non-swipeable view when no navigation context
                    NonSwipeableEntryContent(
                        entry = entry,
                        isLoading = uiState.isLoading,
                        errorMessage = uiState.errorMessage,
                        onLinkClick = { url -> viewModel.openInBrowser(url) },
                        onRetry = { viewModel.retry() },
                        modifier = Modifier.fillMaxSize(),
                    )
                }
            }

            // Narration controls
            entry?.let { currentEntry ->
                val content =
                    currentEntry.entry.contentCleaned
                        ?: currentEntry.entry.contentOriginal

                content?.let {
                    NarrationControls(
                        narrationState = narrationState,
                        onPlay = {
                            narrationViewModel.startNarration(
                                entryId = currentEntry.entry.id,
                                title = currentEntry.entry.title ?: "Untitled",
                                feedTitle = currentEntry.entry.feedTitle,
                                content = it,
                            )
                        },
                        onPause = { narrationViewModel.pauseNarration() },
                        onResume = { narrationViewModel.resumeNarration() },
                        onSkipPrevious = { narrationViewModel.skipBackward() },
                        onSkipNext = { narrationViewModel.skipForward() },
                        onRetry = {
                            narrationViewModel.startNarration(
                                entryId = currentEntry.entry.id,
                                title = currentEntry.entry.title ?: "Untitled",
                                feedTitle = currentEntry.entry.feedTitle,
                                content = it,
                            )
                        },
                        modifier =
                            Modifier
                                .fillMaxWidth()
                                .imePadding(),
                    )
                }
            }
        }
    }
}

/**
 * Swipeable horizontal pager for navigating between entries.
 */
@Composable
private fun SwipeableEntryPager(
    entryIds: List<String>,
    currentIndex: Int,
    listContext: String?,
    currentEntry: EntryWithState?,
    previousEntry: EntryWithState?,
    nextEntry: EntryWithState?,
    isLoading: Boolean,
    errorMessage: String?,
    onNavigateToEntry: (entryId: String, listContext: String?) -> Unit,
    onLinkClick: (String) -> Unit,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val pagerState =
        rememberPagerState(
            initialPage = currentIndex,
            pageCount = { entryIds.size },
        )

    // Navigate to new entry when user settles on a different page
    LaunchedEffect(pagerState) {
        snapshotFlow { pagerState.settledPage }
            .distinctUntilChanged()
            .collect { settledPage ->
                if (settledPage != currentIndex && settledPage in entryIds.indices) {
                    onNavigateToEntry(entryIds[settledPage], listContext)
                }
            }
    }

    HorizontalPager(
        state = pagerState,
        modifier = modifier,
        beyondViewportPageCount = 1, // Preload adjacent pages for smoother swiping
    ) { pageIndex ->
        when {
            pageIndex == currentIndex -> {
                // Current page - show actual content
                NonSwipeableEntryContent(
                    entry = currentEntry,
                    isLoading = isLoading,
                    errorMessage = errorMessage,
                    onLinkClick = onLinkClick,
                    onRetry = onRetry,
                    modifier = Modifier.fillMaxSize(),
                )
            }
            pageIndex == currentIndex - 1 && previousEntry != null -> {
                // Previous page with preloaded content
                NonSwipeableEntryContent(
                    entry = previousEntry,
                    isLoading = false,
                    errorMessage = null,
                    onLinkClick = onLinkClick,
                    onRetry = onRetry,
                    modifier = Modifier.fillMaxSize(),
                )
            }
            pageIndex == currentIndex + 1 && nextEntry != null -> {
                // Next page with preloaded content
                NonSwipeableEntryContent(
                    entry = nextEntry,
                    isLoading = false,
                    errorMessage = null,
                    onLinkClick = onLinkClick,
                    onRetry = onRetry,
                    modifier = Modifier.fillMaxSize(),
                )
            }
            else -> {
                // Other pages - show skeleton while loading
                Box(modifier = Modifier.fillMaxSize()) {
                    EntryDetailSkeleton(modifier = Modifier.fillMaxSize())
                }
            }
        }
    }
}

/**
 * Non-swipeable entry content display.
 *
 * Used when there's no navigation context or as the content within each pager page.
 */
@Composable
private fun NonSwipeableEntryContent(
    entry: EntryWithState?,
    isLoading: Boolean,
    errorMessage: String?,
    onLinkClick: (String) -> Unit,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val scrollState = rememberScrollState()

    when {
        // Loading state - show skeleton
        isLoading && entry == null -> {
            EntryDetailSkeleton(modifier = modifier)
        }

        // Error state with no entry
        errorMessage != null && entry == null -> {
            ErrorState(
                title = "Unable to load article",
                message = errorMessage,
                errorType = ErrorType.GENERIC,
                onRetry = onRetry,
                modifier = modifier,
            )
        }

        // Entry content
        entry != null -> {
            EntryDetailContent(
                entry = entry,
                onLinkClick = onLinkClick,
                scrollState = scrollState,
                modifier = modifier,
            )
        }

        // Fallback empty state
        else -> {
            ErrorState(
                title = "Entry not found",
                message = "The article you're looking for could not be found.",
                errorType = ErrorType.GENERIC,
                modifier = modifier,
            )
        }
    }
}

/**
 * Top app bar for the entry detail screen.
 *
 * Includes back button, star toggle, share, and open in browser actions.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun EntryDetailTopBar(
    entry: EntryWithState?,
    onBack: () -> Unit,
    onToggleStar: () -> Unit,
    onShare: () -> Unit,
    onOpenInBrowser: () -> Unit,
) {
    TopAppBar(
        title = { /* Empty title - content shows the title */ },
        navigationIcon = {
            IconButton(onClick = onBack) {
                Icon(
                    imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                    contentDescription = "Navigate back",
                )
            }
        },
        actions = {
            entry?.let { e ->
                // Star button
                IconButton(onClick = onToggleStar) {
                    Icon(
                        imageVector = if (e.isStarred) Icons.Filled.Star else Icons.Outlined.StarBorder,
                        contentDescription = if (e.isStarred) "Remove from starred" else "Add to starred",
                        tint =
                            if (e.isStarred) {
                                MaterialTheme.colorScheme.tertiary
                            } else {
                                MaterialTheme.colorScheme.onSurfaceVariant
                            },
                    )
                }

                // Share button (only if URL is available)
                e.entry.url?.let {
                    IconButton(onClick = onShare) {
                        Icon(
                            imageVector = Icons.Default.Share,
                            contentDescription = "Share article",
                        )
                    }
                }

                // Open in browser button (only if URL is available)
                e.entry.url?.let {
                    IconButton(onClick = onOpenInBrowser) {
                        Icon(
                            imageVector = Icons.Default.OpenInBrowser,
                            contentDescription = "Open in browser",
                        )
                    }
                }
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
 * Main content of the entry detail screen.
 *
 * Displays the entry header and HTML content in a scrollable column.
 */
@Composable
private fun EntryDetailContent(
    entry: EntryWithState,
    onLinkClick: (String) -> Unit,
    scrollState: androidx.compose.foundation.ScrollState,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier =
            modifier
                .verticalScroll(scrollState)
                .padding(horizontal = 16.dp),
    ) {
        // Header section
        EntryHeader(entry = entry)

        Spacer(modifier = Modifier.height(24.dp))

        // Content section
        val content =
            entry.entry.contentCleaned
                ?: entry.entry.contentOriginal
                ?: entry.entry.summary
                ?: "<p>No content available.</p>"

        HtmlContent(
            html = content,
            onLinkClick = onLinkClick,
            baseUrl = entry.entry.url,
            modifier = Modifier.fillMaxWidth(),
        )

        // Bottom padding for comfortable reading
        Spacer(modifier = Modifier.height(32.dp))
    }
}

/**
 * Entry header with feed name, title, author, and date.
 */
@Composable
private fun EntryHeader(entry: EntryWithState) {
    Column(
        modifier = Modifier.fillMaxWidth(),
    ) {
        // Feed name
        entry.entry.feedTitle?.let { feedTitle ->
            Text(
                text = feedTitle,
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.primary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )

            Spacer(modifier = Modifier.height(8.dp))
        }

        // Title
        Text(
            text = entry.entry.title ?: "Untitled",
            style = MaterialTheme.typography.headlineMedium,
            color = MaterialTheme.colorScheme.onSurface,
        )

        Spacer(modifier = Modifier.height(12.dp))

        // Meta: author and date
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            // Author
            entry.entry.author?.let { author ->
                Text(
                    text = author,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
            }

            // Separator (if both author and date exist)
            if (entry.entry.author != null && entry.entry.publishedAt != null) {
                Text(
                    text = "\u2022",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            // Date
            entry.entry.publishedAt?.let { publishedAt ->
                Text(
                    text = formatDate(publishedAt),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

/**
 * Formats a timestamp to a human-readable date string.
 *
 * @param timestamp Unix timestamp in milliseconds
 * @return Formatted date string
 */
private fun formatDate(timestamp: Long): String {
    val date = Date(timestamp)
    val now = Date()
    val diffMs = now.time - date.time
    val diffDays = diffMs / (1000 * 60 * 60 * 24)

    return when {
        diffDays == 0L -> {
            // Today - show time
            SimpleDateFormat("h:mm a", Locale.getDefault()).format(date)
        }
        diffDays == 1L -> {
            "Yesterday"
        }
        diffDays < 7L -> {
            // This week - show day name
            SimpleDateFormat("EEEE", Locale.getDefault()).format(date)
        }
        else -> {
            // Older - show full date
            SimpleDateFormat("MMM d, yyyy", Locale.getDefault()).format(date)
        }
    }
}
