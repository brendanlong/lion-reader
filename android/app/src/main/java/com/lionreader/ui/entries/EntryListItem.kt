package com.lionreader.ui.entries

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Circle
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.outlined.Circle
import androidx.compose.material.icons.outlined.StarBorder
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.lionreader.data.db.relations.EntryWithState
import java.util.concurrent.TimeUnit

/**
 * Entry list item composable.
 *
 * Displays a single entry in a card format with:
 * - Feed title (as a label)
 * - Entry title
 * - Summary snippet
 * - Relative timestamp
 * - Read/unread indicator (changes opacity and shows dot icon)
 * - Star indicator and toggle button
 *
 * @param entry The entry with its state to display
 * @param onClick Callback when the entry is clicked
 * @param onToggleRead Callback when the read status toggle is clicked
 * @param onToggleStar Callback when the star toggle is clicked
 * @param modifier Modifier for the item
 */
@Composable
fun EntryListItem(
    entry: EntryWithState,
    onClick: () -> Unit,
    onToggleRead: () -> Unit,
    onToggleStar: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val alpha = if (entry.isRead) 0.6f else 1f

    Card(
        modifier =
            modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 4.dp)
                .clickable(onClick = onClick),
        colors =
            CardDefaults.cardColors(
                containerColor =
                    if (entry.isRead) {
                        MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f)
                    } else {
                        MaterialTheme.colorScheme.surface
                    },
            ),
        elevation =
            CardDefaults.cardElevation(
                defaultElevation = if (entry.isRead) 0.dp else 1.dp,
            ),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
        ) {
            // Feed title row with unread indicator
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    // Unread dot indicator
                    if (!entry.isRead) {
                        Icon(
                            imageVector = Icons.Filled.Circle,
                            contentDescription = null,
                            modifier = Modifier.size(8.dp),
                            tint = MaterialTheme.colorScheme.primary,
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                    }

                    // Feed title
                    entry.entry.feedTitle?.let { feedTitle ->
                        Text(
                            text = feedTitle,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.primary.copy(alpha = alpha),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f, fill = false),
                        )
                    }
                }

                // Star indicator (shown even when not in action row)
                if (entry.isStarred) {
                    Icon(
                        imageVector = Icons.Filled.Star,
                        contentDescription = null,
                        modifier = Modifier.size(16.dp),
                        tint = MaterialTheme.colorScheme.tertiary,
                    )
                }
            }

            Spacer(modifier = Modifier.height(4.dp))

            // Entry title
            Text(
                text = entry.entry.title ?: "Untitled",
                style = MaterialTheme.typography.titleMedium,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.alpha(alpha),
            )

            // Summary
            entry.entry.summary?.let { summary ->
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = cleanSummary(summary),
                    style = MaterialTheme.typography.bodySmall,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = alpha),
                )
            }

            Spacer(modifier = Modifier.height(8.dp))

            // Footer: date + actions
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                // Relative timestamp
                Text(
                    text = entry.entry.publishedAt?.let { formatRelativeTime(it) } ?: "",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = alpha),
                )

                // Action buttons
                Row {
                    // Toggle read button
                    IconButton(
                        onClick = onToggleRead,
                        modifier = Modifier.size(32.dp),
                    ) {
                        Icon(
                            imageVector =
                                if (entry.isRead) {
                                    Icons.Outlined.Circle
                                } else {
                                    Icons.Filled.Circle
                                },
                            contentDescription =
                                if (entry.isRead) {
                                    "Mark as unread"
                                } else {
                                    "Mark as read"
                                },
                            modifier = Modifier.size(16.dp),
                            tint = MaterialTheme.colorScheme.primary,
                        )
                    }

                    // Toggle star button
                    IconButton(
                        onClick = onToggleStar,
                        modifier = Modifier.size(32.dp),
                    ) {
                        Icon(
                            imageVector =
                                if (entry.isStarred) {
                                    Icons.Filled.Star
                                } else {
                                    Icons.Outlined.StarBorder
                                },
                            contentDescription =
                                if (entry.isStarred) {
                                    "Remove from starred"
                                } else {
                                    "Add to starred"
                                },
                            modifier = Modifier.size(16.dp),
                            tint =
                                if (entry.isStarred) {
                                    MaterialTheme.colorScheme.tertiary
                                } else {
                                    MaterialTheme.colorScheme.onSurfaceVariant
                                },
                        )
                    }
                }
            }
        }
    }
}

/**
 * Formats a timestamp as a relative time string.
 *
 * Examples: "2m ago", "5h ago", "3d ago", "2w ago"
 *
 * @param timestamp Unix timestamp in milliseconds
 * @return Formatted relative time string
 */
private fun formatRelativeTime(timestamp: Long): String {
    val now = System.currentTimeMillis()
    val diff = now - timestamp

    return when {
        diff < TimeUnit.MINUTES.toMillis(1) -> "Just now"
        diff < TimeUnit.HOURS.toMillis(1) -> {
            val minutes = TimeUnit.MILLISECONDS.toMinutes(diff)
            "${minutes}m ago"
        }
        diff < TimeUnit.DAYS.toMillis(1) -> {
            val hours = TimeUnit.MILLISECONDS.toHours(diff)
            "${hours}h ago"
        }
        diff < TimeUnit.DAYS.toMillis(7) -> {
            val days = TimeUnit.MILLISECONDS.toDays(diff)
            "${days}d ago"
        }
        diff < TimeUnit.DAYS.toMillis(30) -> {
            val weeks = TimeUnit.MILLISECONDS.toDays(diff) / 7
            "${weeks}w ago"
        }
        diff < TimeUnit.DAYS.toMillis(365) -> {
            val months = TimeUnit.MILLISECONDS.toDays(diff) / 30
            "${months}mo ago"
        }
        else -> {
            val years = TimeUnit.MILLISECONDS.toDays(diff) / 365
            "${years}y ago"
        }
    }
}

/**
 * Cleans HTML tags and whitespace from a summary string.
 *
 * @param summary The raw summary text
 * @return Cleaned summary text
 */
private fun cleanSummary(summary: String): String =
    summary
        .replace(Regex("<[^>]*>"), "") // Remove HTML tags
        .replace(Regex("\\s+"), " ") // Normalize whitespace
        .trim()
