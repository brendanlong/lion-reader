package com.lionreader.ui.saved

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.lionreader.data.api.models.SavedArticleFullDto
import com.lionreader.ui.components.ErrorState
import com.lionreader.ui.components.ErrorType
import com.lionreader.ui.entries.HtmlContent
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * Saved article detail screen displaying full article content.
 *
 * Shows the complete article with header (site name, title, author, date),
 * HTML content, and action buttons for starring, sharing, and opening in browser.
 *
 * @param onBack Callback when back navigation is triggered
 * @param viewModel ViewModel managing the article detail state
 * @param modifier Modifier for the screen
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SavedArticleDetailScreen(
    onBack: () -> Unit,
    viewModel: SavedArticleDetailViewModel = hiltViewModel(),
    modifier: Modifier = Modifier,
) {
    val uiState by viewModel.uiState.collectAsStateWithLifecycle()
    val article by viewModel.article.collectAsStateWithLifecycle()
    val scrollState = rememberScrollState()
    val snackbarHostState = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current

    // Handle one-shot events from the ViewModel
    LaunchedEffect(Unit) {
        viewModel.events.collect { event ->
            when (event) {
                is SavedArticleDetailEvent.Share -> {
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
                is SavedArticleDetailEvent.OpenInBrowser -> {
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
            SavedArticleDetailTopBar(
                article = article,
                onBack = onBack,
                onToggleStar = viewModel::toggleStar,
                onShare = { article?.url?.let { viewModel.share(it) } },
                onOpenInBrowser = { article?.url?.let { viewModel.openInBrowser(it) } },
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
            uiState.isLoading && article == null -> {
                Column(
                    modifier =
                        Modifier
                            .fillMaxSize()
                            .padding(padding),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center,
                ) {
                    CircularProgressIndicator()
                }
            }

            // Error state with no article
            uiState.errorMessage != null && article == null -> {
                ErrorState(
                    title = "Unable to load article",
                    message = uiState.errorMessage ?: "Unknown error",
                    errorType = ErrorType.GENERIC,
                    onRetry = { viewModel.retry() },
                    modifier =
                        Modifier
                            .fillMaxSize()
                            .padding(padding),
                )
            }

            // Article content
            article != null -> {
                SavedArticleDetailContent(
                    article = article!!,
                    onLinkClick = { url -> viewModel.openInBrowser(url) },
                    scrollState = scrollState,
                    modifier =
                        Modifier
                            .fillMaxSize()
                            .padding(padding),
                )
            }

            // Fallback empty state
            else -> {
                ErrorState(
                    title = "Article not found",
                    message = "The article you're looking for could not be found.",
                    errorType = ErrorType.GENERIC,
                    modifier =
                        Modifier
                            .fillMaxSize()
                            .padding(padding),
                )
            }
        }
    }
}

/**
 * Top app bar for the saved article detail screen.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SavedArticleDetailTopBar(
    article: SavedArticleFullDto?,
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
            article?.let { a ->
                // Star button
                IconButton(onClick = onToggleStar) {
                    Icon(
                        imageVector = if (a.starred) Icons.Filled.Star else Icons.Outlined.StarBorder,
                        contentDescription = if (a.starred) "Remove from starred" else "Add to starred",
                        tint =
                            if (a.starred) {
                                MaterialTheme.colorScheme.tertiary
                            } else {
                                MaterialTheme.colorScheme.onSurfaceVariant
                            },
                    )
                }

                // Share button
                IconButton(onClick = onShare) {
                    Icon(
                        imageVector = Icons.Default.Share,
                        contentDescription = "Share article",
                    )
                }

                // Open in browser button
                IconButton(onClick = onOpenInBrowser) {
                    Icon(
                        imageVector = Icons.Default.OpenInBrowser,
                        contentDescription = "Open in browser",
                    )
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
 * Main content of the saved article detail screen.
 */
@Composable
private fun SavedArticleDetailContent(
    article: SavedArticleFullDto,
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
        SavedArticleHeader(article = article)

        Spacer(modifier = Modifier.height(24.dp))

        // Content section
        val content =
            article.contentCleaned
                ?: article.contentOriginal
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
 * Article header with site name, title, author, and date.
 */
@Composable
private fun SavedArticleHeader(article: SavedArticleFullDto) {
    Column(
        modifier = Modifier.fillMaxWidth(),
    ) {
        // Site name
        val siteName = article.siteName ?: extractDomain(article.url)
        Text(
            text = siteName,
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.primary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )

        Spacer(modifier = Modifier.height(8.dp))

        // Title
        Text(
            text = article.title ?: "Untitled",
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
            article.author?.let { author ->
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
            if (article.author != null) {
                Text(
                    text = "\u2022",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            // Saved date
            Text(
                text = formatDate(article.savedAt),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/**
 * Extracts the domain from a URL for display.
 */
private fun extractDomain(url: String): String =
    try {
        val host = java.net.URI(url).host ?: url
        host.removePrefix("www.")
    } catch (e: Exception) {
        url
    }

/**
 * Formats an ISO 8601 timestamp to a human-readable date string.
 */
private fun formatDate(isoTimestamp: String): String {
    val instant =
        try {
            Instant.parse(isoTimestamp)
        } catch (e: Exception) {
            return ""
        }

    val now = Instant.now()
    val diffMs = now.toEpochMilli() - instant.toEpochMilli()
    val diffDays = diffMs / (1000 * 60 * 60 * 24)

    val zonedDateTime = instant.atZone(ZoneId.systemDefault())

    return when {
        diffDays == 0L -> {
            // Today - show time
            DateTimeFormatter
                .ofPattern("h:mm a", Locale.getDefault())
                .format(zonedDateTime)
        }
        diffDays == 1L -> {
            "Yesterday"
        }
        diffDays < 7L -> {
            // This week - show day name
            DateTimeFormatter
                .ofPattern("EEEE", Locale.getDefault())
                .format(zonedDateTime)
        }
        else -> {
            // Older - show full date
            DateTimeFormatter
                .ofPattern("MMM d, yyyy", Locale.getDefault())
                .format(zonedDateTime)
        }
    }
}
