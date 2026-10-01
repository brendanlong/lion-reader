package com.lionreader.app.ui

import android.text.format.DateUtils
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
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
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
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
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.lionreader.app.R
import com.lionreader.shared.data.ListScope
import com.lionreader.shared.data.NavSubscription
import com.lionreader.shared.data.Navigation
import com.lionreader.shared.data.TimelineItem
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(
    model: HomeViewModel,
    onOpen: (String) -> Unit,
    /** Whether to highlight the open article: only beside it, where both are on screen. */
    showSelection: Boolean = false,
    onSettings: () -> Unit,
) {
    val drawer = rememberDrawerState(DrawerValue.Closed)
    val coroutines = rememberCoroutineScope()
    val scope by model.scope.collectAsStateWithLifecycle()
    val navigation by model.navigation.collectAsStateWithLifecycle()
    val items by model.items.collectAsStateWithLifecycle()
    val unreadOnly by model.unreadOnly.collectAsStateWithLifecycle()
    val status by model.status.collectAsStateWithLifecycle()
    val expandedTags by model.expandedTags.collectAsStateWithLifecycle()
    val search by model.search.collectAsStateWithLifecycle()
    val searchResults by model.searchResults.collectAsStateWithLifecycle()
    val shown by model.shown.collectAsStateWithLifecycle()
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

    BackHandler(enabled = search != null) { model.setSearch(null) }
    // Apart, so searching doesn't lose the timeline's place; each search starts at the top.
    val timelineList = rememberLazyListState()
    val searchList = remember(search == null) { LazyListState() }

    ModalNavigationDrawer(
        drawerState = drawer,
        // Not while searching: the edge swipe would open it from the search box.
        gesturesEnabled = search == null || drawer.isOpen,
        drawerContent = {
            // Given the state, it closes on back (with the predictive animation).
            ModalDrawerSheet(drawerState = drawer) {
                Drawer(
                    navigation = navigation,
                    selected = scope,
                    expandedTags = expandedTags,
                    onToggleTag = model::toggleTag,
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
                val text = search
                if (text != null) {
                    SearchBar(
                        text,
                        onChange = model::setSearch,
                        onClose = { model.setSearch(null) },
                    )
                } else {
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
                                Icon(
                                    painterResource(R.drawable.ic_menu),
                                    contentDescription = "Lists",
                                )
                            }
                        },
                        actions = {
                            IconButton(onClick = { model.setSearch("") }) {
                                Icon(
                                    painterResource(R.drawable.ic_search),
                                    contentDescription = "Search",
                                )
                            }
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
            }
        ) { padding ->
            PullToRefreshBox(
                isRefreshing = status == SyncStatus.Syncing,
                onRefresh = model::pullToRefresh,
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
                    val text = search
                    EntryList(
                        items = if (text != null) searchResults else items,
                        listState = if (text != null) searchList else timelineList,
                        selectedId = shown.takeIf { showSelection },
                        emptyText =
                            when {
                                text == null && unreadOnly -> "No unread articles"
                                text == null -> "No articles"
                                text.isBlank() -> "Search the articles on this device"
                                else -> "No matching articles on this device"
                            },
                        onOpen = {
                            model.opened(it)
                            onOpen(it)
                        },
                        onToggleRead = model::toggleRead,
                        onToggleStar = model::toggleStar,
                        onLoadMore = { if (text == null) model.loadMore() },
                    )
                }
            }
        }
    }
}

/** The top bar while searching: the search box, with back and clear. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SearchBar(text: String, onChange: (String) -> Unit, onClose: () -> Unit) {
    val focus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    // Once: not again on coming back from an article.
    var focused by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        if (!focused) focus.requestFocus()
        focused = true
    }
    TopAppBar(
        navigationIcon = {
            IconButton(onClick = onClose) {
                Icon(painterResource(R.drawable.ic_arrow_back), contentDescription = "Close search")
            }
        },
        title = {
            TextField(
                value = text,
                onValueChange = onChange,
                placeholder = { Text("Search articles") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                keyboardActions = KeyboardActions(onSearch = { keyboard?.hide() }),
                colors =
                    TextFieldDefaults.colors(
                        focusedContainerColor = Color.Transparent,
                        unfocusedContainerColor = Color.Transparent,
                        focusedIndicatorColor = Color.Transparent,
                        unfocusedIndicatorColor = Color.Transparent,
                    ),
                modifier = Modifier.fillMaxWidth().focusRequester(focus),
            )
        },
        actions = {
            if (text.isNotEmpty()) {
                IconButton(onClick = { onChange("") }) {
                    Icon(painterResource(R.drawable.ic_close), contentDescription = "Clear search")
                }
            }
        },
    )
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

/** Uncategorized's key among the expanded tag ids, as on the web. */
private const val UNCATEGORIZED_KEY = "uncategorized"

private fun title(scope: ListScope, navigation: Navigation?): String =
    when (scope) {
        ListScope.All -> "All"
        ListScope.Starred -> "Starred"
        ListScope.Saved -> "Saved"
        ListScope.Uncategorized -> "Uncategorized"
        is ListScope.Tag -> navigation?.tags?.firstOrNull { it.id == scope.id }?.name ?: "Tag"
        is ListScope.Subscription ->
            navigation?.subscriptions?.firstOrNull { it.id == scope.id }?.title ?: "Feed"
    }

@Composable
private fun Drawer(
    navigation: Navigation?,
    selected: ListScope,
    expandedTags: Set<String>,
    onToggleTag: (String) -> Unit,
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
            fun group(
                key: String,
                name: String,
                unread: Int,
                scope: ListScope,
                subscriptions: List<NavSubscription>,
            ) {
                // The open feed's group shows its feeds, so the open list stays visible.
                val expanded =
                    key in expandedTags ||
                        (selected is ListScope.Subscription &&
                            subscriptions.any { it.id == selected.id })
                item(key = "group-$key") {
                    DrawerRow(
                        name,
                        unread,
                        selected == scope,
                        icon = {
                            if (subscriptions.isNotEmpty()) {
                                ExpandButton(name, expanded) { onToggleTag(key) }
                            } else {
                                // Keeps the name in line with the other groups'.
                                Spacer(Modifier.size(48.dp))
                            }
                        },
                    ) {
                        onSelect(scope)
                    }
                }
                if (!expanded) return
                items(subscriptions, key = { "group-$key-${it.id}" }) { sub ->
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
            for (tag in nav.tags) {
                group(
                    tag.id,
                    tag.name,
                    tag.unread,
                    ListScope.Tag(tag.id),
                    nav.subscriptionsIn(tag.id),
                )
            }
            val uncategorized = nav.uncategorized
            if (nav.tags.isEmpty()) {
                // Without tags there's nothing to group feeds apart from.
                items(uncategorized, key = { "sub-${it.id}" }) { sub ->
                    DrawerRow(sub.title, sub.unread, selected == ListScope.Subscription(sub.id)) {
                        onSelect(ListScope.Subscription(sub.id))
                    }
                }
            } else if (uncategorized.isNotEmpty()) {
                group(
                    UNCATEGORIZED_KEY,
                    "Uncategorized",
                    uncategorized.sumOf { it.unread },
                    ListScope.Uncategorized,
                    uncategorized,
                )
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
private fun ExpandButton(name: String, expanded: Boolean, onClick: () -> Unit) {
    IconButton(onClick = onClick) {
        Icon(
            painterResource(
                if (expanded) R.drawable.ic_expand_more else R.drawable.ic_chevron_right
            ),
            contentDescription = if (expanded) "Collapse $name" else "Expand $name",
        )
    }
}

@Composable
private fun DrawerRow(
    label: String,
    unread: Int?,
    selected: Boolean,
    indent: Boolean = false,
    icon: (@Composable () -> Unit)? = null,
    onClick: () -> Unit,
) {
    NavigationDrawerItem(
        label = { Text(label, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        icon = icon,
        badge = { if (unread != null && unread > 0) Text(unread.toString()) },
        selected = selected,
        onClick = onClick,
        // Lines a tag's feeds up with its name, past the expand button and
        // the item's icon spacing.
        modifier = if (indent) Modifier.padding(start = 60.dp) else Modifier,
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun EntryList(
    items: List<TimelineItem>?,
    listState: LazyListState,
    selectedId: String?,
    emptyText: String,
    onOpen: (String) -> Unit,
    onToggleRead: (TimelineItem) -> Unit,
    onToggleStar: (TimelineItem) -> Unit,
    onLoadMore: () -> Unit,
) {
    if (items == null) return
    if (items.isEmpty()) {
        Text(
            emptyText,
            style = MaterialTheme.typography.bodyLarge,
            modifier = Modifier.fillMaxWidth().padding(32.dp),
        )
        return
    }
    val nearEnd by
        remember(listState) {
            derivedStateOf {
                listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ==
                    listState.layoutInfo.totalItemsCount - 1
            }
        }
    LaunchedEffect(nearEnd) { if (nearEnd) onLoadMore() }
    LazyColumn(state = listState, modifier = Modifier.fillMaxSize()) {
        items(items, key = { it.id }) { item ->
            // Right toggles read, left toggles starred; the row springs back.
            val swipe =
                rememberSwipeToDismissBoxState(
                    confirmValueChange = {
                        when (it) {
                            SwipeToDismissBoxValue.StartToEnd -> onToggleRead(item)
                            SwipeToDismissBoxValue.EndToStart -> onToggleStar(item)
                            SwipeToDismissBoxValue.Settled -> {}
                        }
                        false
                    }
                )
            SwipeToDismissBox(
                state = swipe,
                backgroundContent = { SwipeBackground(swipe.dismissDirection, item) },
            ) {
                EntryRow(
                    item,
                    selected = item.id == selectedId,
                    onOpen = { onOpen(item.id) },
                    onToggleRead = { onToggleRead(item) },
                    onToggleStar = { onToggleStar(item) },
                )
            }
            HorizontalDivider()
        }
    }
}

/** What letting go of a swipe will do, revealed under the row. */
@Composable
private fun SwipeBackground(direction: SwipeToDismissBoxValue, item: TimelineItem) {
    if (direction == SwipeToDismissBoxValue.Settled) return
    val read = direction == SwipeToDismissBoxValue.StartToEnd
    Row(
        modifier =
            Modifier.fillMaxSize()
                .background(MaterialTheme.colorScheme.secondaryContainer)
                .padding(horizontal = 24.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = if (read) Arrangement.Start else Arrangement.End,
    ) {
        Icon(
            painterResource(
                when {
                    read && item.read -> R.drawable.ic_circle
                    read -> R.drawable.ic_circle_outline
                    item.starred -> R.drawable.ic_star_border
                    else -> R.drawable.ic_star
                }
            ),
            // The row's own actions say this to TalkBack.
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSecondaryContainer,
            modifier = Modifier.size(if (read) 16.dp else 24.dp),
        )
    }
}

@Composable
private fun EntryRow(
    item: TimelineItem,
    selected: Boolean,
    onOpen: () -> Unit,
    onToggleRead: () -> Unit,
    onToggleStar: () -> Unit,
) {
    Row(
        modifier =
            Modifier.fillMaxWidth()
                .clickable(onClickLabel = "Open", onClick = onOpen)
                .background(
                    if (selected) MaterialTheme.colorScheme.secondaryContainer
                    else MaterialTheme.colorScheme.surface
                )
                .padding(start = 16.dp, top = 12.dp, bottom = 12.dp)
                // One stop for TalkBack and Switch Access, with the buttons (and
                // the swipe) as actions rather than more stops.
                .semantics {
                    stateDescription =
                        listOfNotNull(
                                if (item.read) "Read" else "Unread",
                                "Starred".takeIf { item.starred },
                            )
                            .joinToString(", ")
                    this.selected = selected
                    customActions =
                        listOf(
                            CustomAccessibilityAction(if (item.starred) "Unstar" else "Star") {
                                onToggleStar()
                                true
                            },
                            CustomAccessibilityAction(
                                if (item.read) "Mark unread" else "Mark read"
                            ) {
                                onToggleRead()
                                true
                            },
                        )
                },
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
        Column(Modifier.clearAndSetSemantics {}) {
            // 44dp (the design system's touch target) keeps a two-button column
            // from stretching short rows.
            IconButton(onClick = onToggleStar, modifier = Modifier.size(44.dp)) {
                Icon(
                    painterResource(
                        if (item.starred) R.drawable.ic_star else R.drawable.ic_star_border
                    ),
                    contentDescription = if (item.starred) "Unstar" else "Star",
                    tint = actionTint(active = item.starred),
                )
            }
            IconButton(onClick = onToggleRead, modifier = Modifier.size(44.dp)) {
                Icon(
                    painterResource(
                        if (item.read) R.drawable.ic_circle_outline else R.drawable.ic_circle
                    ),
                    contentDescription = if (item.read) "Mark unread" else "Mark read",
                    tint = actionTint(active = !item.read),
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
