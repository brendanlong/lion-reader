package com.lionreader.ui.entries

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.OpenInBrowser
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.outlined.StarBorder
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
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.lionreader.data.db.relations.EntryWithState
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Entry detail screen displaying full article content.
 *
 * Shows the complete article with header (feed name, title, author, date),
 * HTML content rendered in a WebView, and action buttons for starring,
 * sharing, and opening in browser.
 *
 * @param onBack Callback when back navigation is triggered
 * @param viewModel ViewModel managing the entry detail state
 * @param modifier Modifier for the screen
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EntryDetailScreen(
    onBack: () -> Unit,
    viewModel: EntryDetailViewModel = hiltViewModel(),
    modifier: Modifier = Modifier,
) {
    val uiState by viewModel.uiState.collectAsStateWithLifecycle()
    val entry by viewModel.entry.collectAsStateWithLifecycle()
    val scrollState = rememberScrollState()
    val snackbarHostState = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current

    // Handle one-shot events from the ViewModel
    LaunchedEffect(Unit) {
        viewModel.events.collect { event ->
            when (event) {
                is EntryDetailEvent.Share -> {
                    val shareIntent = Intent(Intent.ACTION_SEND).apply {
                        type = "text/plain"
                        putExtra(Intent.EXTRA_SUBJECT, event.title)
                        putExtra(Intent.EXTRA_TEXT, "${event.title}\n${event.url}")
                    }
                    context.startActivity(
                        Intent.createChooser(shareIntent, "Share article")
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
        when {
            // Loading state
            uiState.isLoading && entry == null -> {
                LoadingState(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(padding),
                )
            }

            // Error state with no entry
            uiState.errorMessage != null && entry == null -> {
                ErrorState(
                    message = uiState.errorMessage ?: "Unknown error",
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(padding),
                )
            }

            // Entry content
            entry != null -> {
                EntryDetailContent(
                    entry = entry!!,
                    onLinkClick = { url -> viewModel.openInBrowser(url) },
                    scrollState = scrollState,
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(padding),
                )
            }

            // Fallback empty state
            else -> {
                ErrorState(
                    message = "Entry not found",
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(padding),
                )
            }
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
                        tint = if (e.isStarred) {
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
        colors = TopAppBarDefaults.topAppBarColors(
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
        modifier = modifier
            .verticalScroll(scrollState)
            .padding(horizontal = 16.dp),
    ) {
        // Header section
        EntryHeader(entry = entry)

        Spacer(modifier = Modifier.height(24.dp))

        // Content section
        val content = entry.entry.contentCleaned
            ?: entry.entry.contentOriginal
            ?: entry.entry.summary
            ?: "<p>No content available.</p>"

        HtmlContent(
            html = content,
            onLinkClick = onLinkClick,
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
private fun EntryHeader(
    entry: EntryWithState,
) {
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
 * Loading state displayed while the entry is being fetched.
 */
@Composable
private fun LoadingState(
    modifier: Modifier = Modifier,
) {
    Box(
        modifier = modifier,
        contentAlignment = Alignment.Center,
    ) {
        CircularProgressIndicator()
    }
}

/**
 * Error state displayed when the entry cannot be loaded.
 */
@Composable
private fun ErrorState(
    message: String,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier = modifier,
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier.padding(32.dp),
        ) {
            Text(
                text = "Unable to load article",
                style = MaterialTheme.typography.headlineSmall,
                textAlign = TextAlign.Center,
            )

            Spacer(modifier = Modifier.height(8.dp))

            Text(
                text = message,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
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
