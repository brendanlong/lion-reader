package com.lionreader.ui.main

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.automirrored.filled.Label
import androidx.compose.material.icons.filled.RssFeed
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.Badge
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.NavigationDrawerItem
import androidx.compose.material3.NavigationDrawerItemDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.lionreader.data.db.entities.TagEntity
import com.lionreader.data.db.relations.SubscriptionWithFeed
import com.lionreader.ui.navigation.Screen

/**
 * Navigation drawer content for the app.
 *
 * Displays navigation items for:
 * - All entries
 * - Starred entries
 * - Tags with colored indicators
 * - Feeds/Subscriptions with unread counts
 * - Sign Out option
 *
 * @param subscriptions List of subscriptions to display
 * @param tags List of tags to display
 * @param currentRoute Current navigation route for selection state
 * @param totalUnreadCount Total unread count for "All" item badge
 * @param onNavigate Callback when a navigation item is selected
 * @param onSignOut Callback when sign out is clicked
 * @param modifier Modifier for the drawer sheet
 */
@Composable
fun AppDrawer(
    subscriptions: List<SubscriptionWithFeed>,
    tags: List<TagEntity>,
    currentRoute: String,
    totalUnreadCount: Int,
    onNavigate: (String) -> Unit,
    onSignOut: () -> Unit,
    modifier: Modifier = Modifier,
) {
    ModalDrawerSheet(modifier = modifier) {
        Column(
            modifier = Modifier
                .fillMaxHeight()
                .verticalScroll(rememberScrollState()),
        ) {
            // Header
            DrawerHeader()

            Spacer(modifier = Modifier.height(8.dp))

            // All entries
            NavigationDrawerItem(
                label = { Text("All") },
                icon = {
                    Icon(
                        imageVector = Icons.AutoMirrored.Filled.List,
                        contentDescription = null,
                    )
                },
                badge = {
                    if (totalUnreadCount > 0) {
                        Badge {
                            Text(formatCount(totalUnreadCount))
                        }
                    }
                },
                selected = currentRoute == Screen.All.route,
                onClick = { onNavigate(Screen.All.route) },
                modifier = Modifier.padding(NavigationDrawerItemDefaults.ItemPadding),
            )

            // Starred
            NavigationDrawerItem(
                label = { Text("Starred") },
                icon = {
                    Icon(
                        imageVector = Icons.Default.Star,
                        contentDescription = null,
                    )
                },
                selected = currentRoute == Screen.Starred.route,
                onClick = { onNavigate(Screen.Starred.route) },
                modifier = Modifier.padding(NavigationDrawerItemDefaults.ItemPadding),
            )

            HorizontalDivider(modifier = Modifier.padding(vertical = 8.dp))

            // Tags section
            if (tags.isNotEmpty()) {
                Text(
                    text = "Tags",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 28.dp, vertical = 8.dp),
                )

                tags.forEach { tag ->
                    val tagRoute = Screen.Tag.createRoute(tag.id)
                    NavigationDrawerItem(
                        label = { Text(tag.name) },
                        icon = {
                            TagColorIndicator(color = tag.color)
                        },
                        badge = {
                            if (tag.feedCount > 0) {
                                Text(
                                    text = tag.feedCount.toString(),
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        },
                        selected = currentRoute == tagRoute,
                        onClick = { onNavigate(tagRoute) },
                        modifier = Modifier.padding(NavigationDrawerItemDefaults.ItemPadding),
                    )
                }

                HorizontalDivider(modifier = Modifier.padding(vertical = 8.dp))
            }

            // Feeds section
            Text(
                text = "Feeds",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 28.dp, vertical = 8.dp),
            )

            subscriptions.forEach { sub ->
                val feedRoute = Screen.Feed.createRoute(sub.subscription.feedId)
                NavigationDrawerItem(
                    label = {
                        Text(
                            text = sub.displayTitle,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    },
                    icon = {
                        Icon(
                            imageVector = Icons.Default.RssFeed,
                            contentDescription = null,
                        )
                    },
                    badge = {
                        if (sub.subscription.unreadCount > 0) {
                            Badge {
                                Text(formatCount(sub.subscription.unreadCount))
                            }
                        }
                    },
                    selected = currentRoute == feedRoute,
                    onClick = { onNavigate(feedRoute) },
                    modifier = Modifier.padding(NavigationDrawerItemDefaults.ItemPadding),
                )
            }

            Spacer(modifier = Modifier.weight(1f))

            HorizontalDivider()

            // Sign out
            NavigationDrawerItem(
                label = { Text("Sign Out") },
                icon = {
                    Icon(
                        imageVector = Icons.AutoMirrored.Filled.Logout,
                        contentDescription = null,
                    )
                },
                selected = false,
                onClick = onSignOut,
                modifier = Modifier.padding(NavigationDrawerItemDefaults.ItemPadding),
            )

            Spacer(modifier = Modifier.height(16.dp))
        }
    }
}

/**
 * Drawer header with app name/logo.
 */
@Composable
private fun DrawerHeader() {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(120.dp)
            .background(MaterialTheme.colorScheme.primaryContainer),
        contentAlignment = Alignment.BottomStart,
    ) {
        Text(
            text = "Lion Reader",
            style = MaterialTheme.typography.headlineSmall,
            color = MaterialTheme.colorScheme.onPrimaryContainer,
            modifier = Modifier.padding(16.dp),
        )
    }
}

/**
 * Colored circle indicator for tags.
 *
 * Shows a colored dot if the tag has a color, otherwise shows a label icon.
 */
@Composable
private fun TagColorIndicator(color: String?) {
    if (color != null) {
        Box(
            modifier = Modifier
                .size(12.dp)
                .background(
                    color = parseHexColor(color),
                    shape = CircleShape,
                ),
        )
    } else {
        Icon(
            imageVector = Icons.AutoMirrored.Filled.Label,
            contentDescription = null,
        )
    }
}

/**
 * Parses a hex color string to a Compose Color.
 *
 * Supports formats: "#RRGGBB" and "#AARRGGBB"
 */
private fun parseHexColor(hexColor: String): Color {
    return try {
        val colorString = hexColor.removePrefix("#")
        val colorLong = when (colorString.length) {
            6 -> "FF$colorString".toLong(16)
            8 -> colorString.toLong(16)
            else -> 0xFFCCCCCC
        }
        Color(colorLong)
    } catch (e: Exception) {
        Color(0xFFCCCCCC)
    }
}

/**
 * Formats a count for display in badges.
 *
 * Shows the actual number up to 99, then "99+" for larger values.
 */
private fun formatCount(count: Int): String {
    return if (count > 99) "99+" else count.toString()
}
