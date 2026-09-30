package com.lionreader.app.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.lionreader.app.AccountSession
import com.lionreader.app.AppGraph
import com.lionreader.app.AppSettings
import com.lionreader.shared.api.ApiException
import com.lionreader.shared.data.ListScope
import com.lionreader.shared.data.Navigation
import com.lionreader.shared.data.Reader
import com.lionreader.shared.data.TimelineItem
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private const val PAGE = 200L
private const val SEARCH_LIMIT = 200L
private const val MAX_KEPT = 200

sealed interface SyncStatus {
    data object Idle : SyncStatus

    data object Syncing : SyncStatus

    data class Failed(val message: String) : SyncStatus
}

@OptIn(ExperimentalCoroutinesApi::class)
class HomeViewModel(
    private val reader: Reader,
    settings: Flow<AppSettings>,
    private val updateSettings: suspend ((AppSettings) -> AppSettings) -> Unit,
    private val sync: suspend () -> Unit,
    /** The article being narrated, which (like one opened) stays in an unread-only list. */
    narrated: Flow<String?> = emptyFlow(),
) : ViewModel() {
    constructor(
        graph: AppGraph,
        account: AccountSession,
    ) : this(
        account.reader,
        graph.settings.settings,
        graph.settings::update,
        {
            // The lists are what the spinner waits for; bodies follow in the
            // background.
            withContext(Dispatchers.IO) { account.sync.sync(downloadContent = false) }
            graph.syncInBackground()
        },
        graph.narrator.state.map { it?.entryId },
    )

    private val _scope = MutableStateFlow<ListScope>(ListScope.All)
    val scope: StateFlow<ListScope> = _scope.asStateFlow()

    /** Entries touched since the list was chosen stay in an unread-only list. */
    private val keepIds = MutableStateFlow<Set<String>>(emptySet())
    private val limit = MutableStateFlow(PAGE)

    private val _status = MutableStateFlow<SyncStatus>(SyncStatus.Idle)
    val status: StateFlow<SyncStatus> = _status.asStateFlow()

    val unreadOnly: StateFlow<Boolean> =
        settings.map { it.unreadOnly }.stateIn(viewModelScope, SharingStarted.Eagerly, true)

    val expandedTags: StateFlow<Set<String>> =
        settings.map { it.expandedTags }.stateIn(viewModelScope, SharingStarted.Eagerly, emptySet())

    val navigation: StateFlow<Navigation?> =
        reader.navigation().stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)

    val items: StateFlow<List<TimelineItem>?> =
        combine(_scope, unreadOnly, keepIds, limit) { scope, unread, keep, limit ->
                Query(scope, unread, keep, limit)
            }
            .flatMapLatest { reader.timeline(it.scope, it.unreadOnly, it.keepIds, it.limit) }
            .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)

    private val _search = MutableStateFlow<String?>(null)

    /** What's typed in the search box; null when not searching. */
    val search: StateFlow<String?> = _search.asStateFlow()

    /** Articles on the device matching [search], newest first; null when not searching. */
    val searchResults: StateFlow<List<TimelineItem>?> =
        _search
            .flatMapLatest { text ->
                if (text == null) flowOf(null) else reader.search(text, SEARCH_LIMIT)
            }
            .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)

    fun setSearch(text: String?) {
        _search.value = text
    }

    /** The ids of the list on screen (search results while searching), for paging through. */
    fun shownIds(): List<String> =
        (if (_search.value != null) searchResults.value else items.value).orEmpty().map { it.id }

    private data class Query(
        val scope: ListScope,
        val unreadOnly: Boolean,
        val keepIds: Set<String>,
        val limit: Long,
    )

    init {
        refresh()
        viewModelScope.launch { narrated.distinctUntilChanged().filterNotNull().collect(::keep) }
    }

    fun select(scope: ListScope) {
        _scope.value = scope
        keepIds.value = emptySet()
        limit.value = PAGE
    }

    fun loadMore() {
        limit.value += PAGE
    }

    fun opened(id: String) = keep(id)

    /** Bounded: the ids are bound into one query (SQLite allows 999 variables). */
    private fun keep(id: String) {
        keepIds.value = (keepIds.value - id + id).toList().takeLast(MAX_KEPT).toSet()
    }

    fun setUnreadOnly(value: Boolean) {
        keepIds.value = emptySet()
        viewModelScope.launch { updateSettings { it.copy(unreadOnly = value) } }
    }

    fun toggleTag(tagId: String) {
        viewModelScope.launch {
            updateSettings {
                val expanded = it.expandedTags
                it.copy(
                    expandedTags = if (tagId in expanded) expanded - tagId else expanded + tagId
                )
            }
        }
    }

    fun toggleRead(item: TimelineItem) {
        keep(item.id)
        viewModelScope.launch { reader.setRead(listOf(item.id), !item.read) }
    }

    fun toggleStar(item: TimelineItem) {
        viewModelScope.launch { reader.setStarred(item.id, !item.starred) }
    }

    /** The entries mark-all-read would mark, taken when the user is asked to confirm. */
    suspend fun unreadInList(): List<String> = reader.unreadIds(_scope.value)

    fun markRead(ids: List<String>) {
        keepIds.value = emptySet()
        viewModelScope.launch { reader.setRead(ids, true) }
    }

    fun refresh() {
        if (_status.value == SyncStatus.Syncing) return
        _status.value = SyncStatus.Syncing
        viewModelScope.launch {
            _status.value =
                try {
                    sync()
                    SyncStatus.Idle
                } catch (e: CancellationException) {
                    throw e
                } catch (e: ApiException) {
                    SyncStatus.Failed(
                        if (e.status == 0) "Signed out" else "Sync failed (${e.status})"
                    )
                } catch (e: java.io.IOException) {
                    SyncStatus.Failed("Offline — showing saved articles")
                } catch (e: Exception) {
                    // Token endpoint 5xx, a captive portal's HTML, a DB error:
                    // report it, never crash the screen.
                    SyncStatus.Failed("Sync failed")
                }
        }
    }
}
