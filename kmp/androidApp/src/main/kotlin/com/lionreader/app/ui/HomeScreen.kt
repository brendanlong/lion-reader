package com.lionreader.app.ui

import android.text.format.DateUtils
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.NavigationDrawerItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberDrawerState
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.lionreader.app.R
import com.lionreader.shared.data.ListScope
import com.lionreader.shared.data.Navigation
import com.lionreader.shared.data.TimelineItem
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(model: HomeViewModel, onOpen: (String) -> Unit, onSettings: () -> Unit) {
    val drawer = rememberDrawerState(DrawerValue.Closed)
    val coroutines = rememberCoroutineScope()
    val scope by model.scope.collectAsStateWithLifecycle()
    val navigation by model.navigation.collectAsStateWithLifecycle()
    val items by model.items.collectAsStateWithLifecycle()
    val unreadOnly by model.unreadOnly.collectAsStateWithLifecycle()
    val status by model.status.collectAsStateWithLifecycle()
    // The entries the confirmation counted; exactly these are marked, so
    // anything a sync adds while the dialog is open isn't marked unseen.
    var markAllIds by remember { mutableStateOf<List<String>?>(null) }

    markAllIds?.let { ids ->
        MarkAllReadDialog(
            listName = title(scope, navigation),
            unread = ids.size,
            onConfirm = {
                markAllIds = null
                model.markRead(ids)
            },
            onDismiss = { markAllIds = null },
        )
    }

    ModalNavigationDrawer(
        drawerState = drawer,
        drawerContent = {
            ModalDrawerSheet {
                Drawer(
                    navigation = navigation,
                    selected = scope,
                    onSelect = {
                        model.select(it)
                        coroutines.launch { drawer.close() }
                    },
                    onSettings = {
                        coroutines.launch { drawer.close() }
                        onSettings()
                    },
                )
            }
        },
    ) {
        Scaffold(
            topBar = {
                TopAppBar(
                    title = {
                        Text(
                            title(scope, navigation),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    },
                    navigationIcon = {
                        IconButton(onClick = { coroutines.launch { drawer.open() } }) {
                            Icon(painterResource(R.drawable.ic_menu), contentDescription = "Lists")
                        }
                    },
                    actions = {
                        ListMenu(
                            showRead = !unreadOnly,
                            onShowReadChange = { model.setUnreadOnly(!it) },
                            onMarkAllRead = {
                                coroutines.launch { markAllIds = model.unreadInList() }
                            },
                        )
                    },
                )
            }
        ) { padding ->
            PullToRefreshBox(
                isRefreshing = status == SyncStatus.Syncing,
                onRefresh = model::refresh,
                modifier = Modifier.padding(padding).fillMaxSize(),
            ) {
                Column {
                    (status as? SyncStatus.Failed)?.let {
                        Text(
                            it.message,
                            style = MaterialTheme.typography.bodySmall,
                            modifier =
                                Modifier.fillMaxWidth()
                                    .padding(horizontal = 16.dp, vertical = 6.dp),
                        )
                        HorizontalDivider()
                    }
                    EntryList(
                        items = items,
                        unreadOnly = unreadOnly,
                        onOpen = {
                            model.opened(it)
                            onOpen(it)
                        },
                        onToggleRead = model::toggleRead,
                        onToggleStar = model::toggleStar,
                        onLoadMore = model::loadMore,
                    )
                }
            }
        }
    }
}

@Composable
private fun ListMenu(
    showRead: Boolean,
    onShowReadChange: (Boolean) -> Unit,
    onMarkAllRead: () -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    Box {
        IconButton(onClick = { open = true }) {
            Icon(painterResource(R.drawable.ic_more_vert), contentDescription = "List options")
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            DropdownMenuItem(
                text = { Text("Show read articles") },
                trailingIcon = { Checkbox(checked = showRead, onCheckedChange = null) },
                onClick = {
                    open = false
                    onShowReadChange(!showRead)
                },
            )
            DropdownMenuItem(
                text = { Text("Mark all as read…") },
                onClick = {
                    open = false
                    onMarkAllRead()
                },
            )
        }
    }
}

@Composable
private fun MarkAllReadDialog(
    listName: String,
    unread: Int,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Mark all as read?") },
        text = {
            Text(
                if (unread == 0) "There are no unread articles in $listName."
                else
                    "Mark ${if (unread == 1) "1 article" else "$unread articles"} in $listName as read?"
            )
        },
        confirmButton = {
            TextButton(onClick = onConfirm, enabled = unread > 0) { Text("Mark read") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

private fun title(scope: ListScope, navigation: Navigation?): String =
    when (scope) {
        ListScope.All -> "All"
        ListScope.Starred -> "Starred"
        ListScope.Saved -> "Saved"
        is ListScope.Tag -> navigation?.tags?.firstOrNull { it.id == scope.id }?.name ?: "Tag"
        is ListScope.Subscription ->
            navigation?.subscriptions?.firstOrNull { it.id == scope.id }?.title ?: "Feed"
    }

@Composable
private fun Drawer(
    navigation: Navigation?,
    selected: ListScope,
    onSelect: (ListScope) -> Unit,
    onSettings: () -> Unit,
) {
    LazyColumn(modifier = Modifier.padding(horizontal = 12.dp)) {
        item {
            Text(
                "Lion Reader",
                style = MaterialTheme.typography.titleLarge,
                modifier = Modifier.padding(16.dp),
            )
        }
        item {
            DrawerRow("All", navigation?.allUnread, selected == ListScope.All) {
                onSelect(ListScope.All)
            }
        }
        item {
            DrawerRow("Starred", navigation?.starredUnread, selected == ListScope.Starred) {
                onSelect(ListScope.Starred)
            }
        }
        item {
            DrawerRow("Saved", navigation?.savedUnread, selected == ListScope.Saved) {
                onSelect(ListScope.Saved)
            }
        }
        navigation?.let { nav ->
            if (nav.tags.isNotEmpty() || nav.subscriptions.isNotEmpty()) {
                item { HorizontalDivider(modifier = Modifier.padding(vertical = 8.dp)) }
            }
            for (tag in nav.tags) {
                item(key = "tag-${tag.id}") {
                    DrawerRow(tag.name, tag.unread, selected == ListScope.Tag(tag.id)) {
                        onSelect(ListScope.Tag(tag.id))
                    }
                }
                items(nav.subscriptionsIn(tag.id), key = { "tag-${tag.id}-${it.id}" }) { sub ->
                    DrawerRow(
                        sub.title,
                        sub.unread,
                        selected == ListScope.Subscription(sub.id),
                        indent = true,
                    ) {
                        onSelect(ListScope.Subscription(sub.id))
                    }
                }
            }
            items(nav.uncategorized, key = { "sub-${it.id}" }) { sub ->
                DrawerRow(sub.title, sub.unread, selected == ListScope.Subscription(sub.id)) {
                    onSelect(ListScope.Subscription(sub.id))
                }
            }
        }
        item { HorizontalDivider(modifier = Modifier.padding(vertical = 8.dp)) }
        item {
            NavigationDrawerItem(
                label = { Text("Settings") },
                icon = { Icon(painterResource(R.drawable.ic_settings), contentDescription = null) },
                selected = false,
                onClick = onSettings,
            )
        }
    }
}

@Composable
private fun DrawerRow(
    label: String,
    unread: Int?,
    selected: Boolean,
    indent: Boolean = false,
    onClick: () -> Unit,
) {
    NavigationDrawerItem(
        label = { Text(label, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        badge = { if (unread != null && unread > 0) Text(unread.toString()) },
        selected = selected,
        onClick = onClick,
        modifier = if (indent) Modifier.padding(start = 16.dp) else Modifier,
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun EntryList(
    items: List<TimelineItem>?,
    unreadOnly: Boolean,
    onOpen: (String) -> Unit,
    onToggleRead: (TimelineItem) -> Unit,
    onToggleStar: (TimelineItem) -> Unit,
    onLoadMore: () -> Unit,
) {
    if (items == null) return
    if (items.isEmpty()) {
        Text(
            if (unreadOnly) "No unread articles" else "No articles",
            style = MaterialTheme.typography.bodyLarge,
            modifier = Modifier.fillMaxWidth().padding(32.dp),
        )
        return
    }
    val list = rememberLazyListState()
    val nearEnd by remember {
        derivedStateOf {
            list.layoutInfo.visibleItemsInfo.lastOrNull()?.index ==
                list.layoutInfo.totalItemsCount - 1
        }
    }
    LaunchedEffect(nearEnd) { if (nearEnd) onLoadMore() }
    LazyColumn(state = list, modifier = Modifier.fillMaxSize()) {
        items(items, key = { it.id }) { item ->
            val swipe =
                rememberSwipeToDismissBoxState(
                    confirmValueChange = {
                        if (it != SwipeToDismissBoxValue.Settled) onToggleRead(item)
                        false
                    }
                )
            SwipeToDismissBox(state = swipe, backgroundContent = {}) {
                EntryRow(
                    item,
                    onOpen = { onOpen(item.id) },
                    onToggleRead = { onToggleRead(item) },
                    onToggleStar = { onToggleStar(item) },
                )
            }
            HorizontalDivider()
        }
    }
}

@Composable
private fun EntryRow(
    item: TimelineItem,
    onOpen: () -> Unit,
    onToggleRead: () -> Unit,
    onToggleStar: () -> Unit,
) {
    Row(
        modifier =
            Modifier.fillMaxWidth()
                .clickable(onClick = onOpen)
                .background(MaterialTheme.colorScheme.surface)
                .padding(start = 16.dp, top = 12.dp, bottom = 12.dp)
                .semantics { stateDescription = if (item.read) "Read" else "Unread" },
        verticalAlignment = Alignment.Top,
    ) {
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                listOfNotNull(item.source, relativeTime(item.sortAtMillis)).joinToString(" · "),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                item.title ?: "Untitled",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = if (item.read) FontWeight.Normal else FontWeight.SemiBold,
                color =
                    if (item.read) MaterialTheme.colorScheme.onSurfaceVariant
                    else MaterialTheme.colorScheme.onSurface,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
            )
            item.summary
                ?.takeIf { it.isNotBlank() }
                ?.let {
                    Text(
                        it,
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
        }
        Column {
            // 44dp (the design system's touch target) keeps a two-button column
            // from stretching short rows.
            IconButton(onClick = onToggleStar, modifier = Modifier.size(44.dp)) {
                Icon(
                    painterResource(
                        if (item.starred) R.drawable.ic_star else R.drawable.ic_star_border
                    ),
                    contentDescription = if (item.starred) "Unstar" else "Star",
                    tint =
                        if (item.starred) MaterialTheme.colorScheme.primary
                        else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            IconButton(onClick = onToggleRead, modifier = Modifier.size(44.dp)) {
                Icon(
                    painterResource(
                        if (item.read) R.drawable.ic_circle_outline else R.drawable.ic_circle
                    ),
                    contentDescription = if (item.read) "Mark unread" else "Mark read",
                    tint =
                        if (item.read) MaterialTheme.colorScheme.onSurfaceVariant
                        else MaterialTheme.colorScheme.primary,
                    modifier = Modifier.size(16.dp),
                )
            }
        }
    }
}

private fun relativeTime(millis: Long): String =
    DateUtils.getRelativeTimeSpanString(
            millis,
            System.currentTimeMillis(),
            DateUtils.MINUTE_IN_MILLIS,
        )
        .toString()
