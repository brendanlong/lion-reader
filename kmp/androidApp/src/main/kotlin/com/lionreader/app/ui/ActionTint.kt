package com.lionreader.app.ui

import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import com.lionreader.app.R

/** Entry action icons (list rows and the article's top bar): amber for an active state. */
@Composable
internal fun actionTint(active: Boolean): Color =
    if (active) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant

/** The read toggle's icon: a filled dot while unread. */
@Composable
internal fun ReadToggleIcon(read: Boolean) {
    Icon(
        painterResource(if (read) R.drawable.ic_circle_outline else R.drawable.ic_circle),
        contentDescription = if (read) "Mark unread" else "Mark read",
        tint = actionTint(active = !read),
        // Smaller than the rest: a full-size filled dot outweighs the outline
        // icons beside it.
        modifier = Modifier.size(16.dp),
    )
}

@Composable
internal fun StarToggleIcon(starred: Boolean) {
    Icon(
        painterResource(if (starred) R.drawable.ic_star else R.drawable.ic_star_border),
        contentDescription = if (starred) "Unstar" else "Star",
        tint = actionTint(active = starred),
    )
}
