package com.lionreader.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material.icons.filled.Inbox
import androidx.compose.material.icons.filled.RssFeed
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.outlined.Inbox
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

/**
 * Types of empty states that can be displayed.
 */
enum class EmptyStateType {
    /** No entries in the current view */
    NO_ENTRIES,

    /** All entries have been read (unread-only filter) */
    ALL_CAUGHT_UP,

    /** No feeds subscribed yet (new user) */
    NO_FEEDS,

    /** No starred entries */
    NO_STARRED,

    /** Offline with no cached content */
    OFFLINE,

    /** Generic empty state */
    GENERIC,
}

/**
 * A reusable empty state component.
 *
 * Displays an icon, title, and message to indicate that there is no content
 * to display. Supports different empty state types with contextual messaging.
 *
 * @param title The title text to display
 * @param message The message text to display
 * @param modifier Modifier for the component
 * @param icon Optional custom icon. If null, a default is used based on type.
 * @param iconTint Optional tint color for the icon
 * @param actionLabel Optional label for action button
 * @param onAction Optional callback for action button
 */
@Composable
fun EmptyState(
    title: String,
    message: String,
    modifier: Modifier = Modifier,
    icon: ImageVector = Icons.Outlined.Inbox,
    iconTint: Color = MaterialTheme.colorScheme.onSurfaceVariant,
    actionLabel: String? = null,
    onAction: (() -> Unit)? = null,
) {
    Box(
        modifier = modifier.fillMaxSize(),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            modifier =
                Modifier
                    .fillMaxWidth()
                    .padding(32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            // Icon
            Icon(
                imageVector = icon,
                contentDescription = null,
                modifier = Modifier.size(72.dp),
                tint = iconTint,
            )

            Spacer(modifier = Modifier.height(24.dp))

            // Title
            Text(
                text = title,
                style = MaterialTheme.typography.headlineSmall,
                color = MaterialTheme.colorScheme.onSurface,
                textAlign = TextAlign.Center,
            )

            Spacer(modifier = Modifier.height(8.dp))

            // Message
            Text(
                text = message,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )

            // Optional action button
            if (actionLabel != null && onAction != null) {
                Spacer(modifier = Modifier.height(24.dp))

                Button(onClick = onAction) {
                    Text(text = actionLabel)
                }
            }
        }
    }
}

/**
 * Empty state for when there are no entries in a view.
 *
 * @param modifier Modifier for the component
 */
@Composable
fun NoEntriesEmptyState(modifier: Modifier = Modifier) {
    EmptyState(
        title = "No Entries",
        message = "No entries in this view yet.",
        icon = Icons.Outlined.Inbox,
        modifier = modifier,
    )
}

/**
 * Empty state for when all entries have been read.
 *
 * Shows a celebratory message indicating the user is caught up.
 *
 * @param modifier Modifier for the component
 * @param onShowAll Optional callback to show all entries instead of just unread
 */
@Composable
fun AllCaughtUpEmptyState(
    modifier: Modifier = Modifier,
    onShowAll: (() -> Unit)? = null,
) {
    EmptyState(
        title = "All Caught Up!",
        message = "You've read all your entries. Check back later for new content, or show all entries.",
        icon = Icons.Default.CheckCircle,
        iconTint = MaterialTheme.colorScheme.primary,
        actionLabel = if (onShowAll != null) "Show All Entries" else null,
        onAction = onShowAll,
        modifier = modifier,
    )
}

/**
 * Empty state for when the user has no feeds.
 *
 * Shown to new users who haven't subscribed to any feeds yet.
 *
 * @param modifier Modifier for the component
 */
@Composable
fun NoFeedsEmptyState(modifier: Modifier = Modifier) {
    EmptyState(
        title = "No Feeds",
        message = "You haven't subscribed to any feeds yet. Subscribe to feeds on the web app to see entries here.",
        icon = Icons.Default.RssFeed,
        modifier = modifier,
    )
}

/**
 * Empty state for when there are no starred entries.
 *
 * @param modifier Modifier for the component
 */
@Composable
fun NoStarredEmptyState(modifier: Modifier = Modifier) {
    EmptyState(
        title = "No Starred Entries",
        message = "You haven't starred any entries yet. Tap the star icon on entries you want to save for later.",
        icon = Icons.Default.Star,
        iconTint = MaterialTheme.colorScheme.tertiary,
        modifier = modifier,
    )
}

/**
 * Empty state for when offline with no cached content.
 *
 * @param modifier Modifier for the component
 * @param onRetry Optional callback for retry action
 */
@Composable
fun OfflineEmptyState(
    modifier: Modifier = Modifier,
    onRetry: (() -> Unit)? = null,
) {
    EmptyState(
        title = "You're Offline",
        message = "Connect to the internet to load entries. Pull down to refresh when you're back online.",
        icon = Icons.Default.CloudOff,
        actionLabel = if (onRetry != null) "Retry" else null,
        onAction = onRetry,
        modifier = modifier,
    )
}

/**
 * Empty state specifically for the entry list screen.
 *
 * Automatically selects the appropriate empty state based on context.
 *
 * @param isUnreadOnly Whether the unread-only filter is active
 * @param isStarredOnly Whether viewing starred entries only
 * @param isOnline Whether the device is online
 * @param hasFeedsSubscribed Whether the user has any feed subscriptions
 * @param modifier Modifier for the component
 * @param onShowAll Optional callback to show all entries (for unread-only mode)
 */
@Composable
fun EntryListEmptyState(
    isUnreadOnly: Boolean,
    isStarredOnly: Boolean,
    isOnline: Boolean,
    hasFeedsSubscribed: Boolean,
    modifier: Modifier = Modifier,
    onShowAll: (() -> Unit)? = null,
) {
    when {
        !isOnline && !hasFeedsSubscribed -> {
            OfflineEmptyState(modifier = modifier)
        }
        !hasFeedsSubscribed -> {
            NoFeedsEmptyState(modifier = modifier)
        }
        isStarredOnly -> {
            NoStarredEmptyState(modifier = modifier)
        }
        isUnreadOnly -> {
            AllCaughtUpEmptyState(
                modifier = modifier,
                onShowAll = onShowAll,
            )
        }
        else -> {
            NoEntriesEmptyState(modifier = modifier)
        }
    }
}
