package com.lionreader.shared.home

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.lionreader.shared.api.ApiException
import com.lionreader.shared.api.ApiFailure
import com.lionreader.shared.api.failure
import com.lionreader.shared.data.ListScope
import com.lionreader.shared.data.Navigation
import com.lionreader.shared.data.Reader
import com.lionreader.shared.data.TimelineItem
import com.lionreader.shared.settings.AppSettings
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.io.IOException

private const val SEARCH_LIMIT = 200L

data class Timeline(val scope: ListScope, val oldestFirst: Boolean, val items: List<TimelineItem>)

sealed interface SyncStatus {
    data object Idle : SyncStatus

    data object Syncing : SyncStatus

    data class Failed(val message: String) : SyncStatus
}

/**
 * The article lists: which is on screen and its entries, the drawer's lists, search, and syncing
 * when asked. [sync] is what pulling to refresh waits for.
 */
@OptIn(ExperimentalCoroutinesApi::class, FlowPreview::class)
class HomeViewModel(
    private val reader: Reader,
    settings: Flow<AppSettings>,
    private val updateSettings: suspend ((AppSettings) -> AppSettings) -> Unit,
    private val sync: suspend () -> Unit,
) : ViewModel() {

    /** Every change to it is one [ListState] step, so a query never sees half of one. */
    private val view = MutableStateFlow(ListState())

    val scope: StateFlow<ListScope> =
        view.map { it.scope }.stateIn(viewModelScope, SharingStarted.Eagerly, ListScope.All)

    private val _status = MutableStateFlow<SyncStatus>(SyncStatus.Idle)
    val status: StateFlow<SyncStatus> = _status.asStateFlow()

    val unreadOnly: StateFlow<Boolean> =
        settings.map { it.unreadOnly }.stateIn(viewModelScope, SharingStarted.Eagerly, true)

    val oldestFirst: StateFlow<Boolean> =
        settings.map { it.oldestFirst }.stateIn(viewModelScope, SharingStarted.Eagerly, false)

    val hideEmptyLists: StateFlow<Boolean> =
        settings.map { it.hideEmptyLists }.stateIn(viewModelScope, SharingStarted.Eagerly, false)

    val expandedTags: StateFlow<Set<String>> =
        settings.map { it.expandedTags }.stateIn(viewModelScope, SharingStarted.Eagerly, emptySet())

    val navigation: StateFlow<Navigation?> =
        reader.navigation().stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)

    /**
     * The list's entries, with which list and order they're in (so a switch can wait for them, and
     * a new order start at the top). From [settings] rather than [unreadOnly] and [oldestFirst],
     * whose placeholder values before the settings load would query a list only to replace it.
     */
    val timeline: StateFlow<Timeline?> =
        combine(
                view,
                settings.map { it.unreadOnly to it.oldestFirst }.distinctUntilChanged(),
                ::Pair,
            )
            .flatMapLatest { (view, filters) ->
                val (unreadOnly, oldestFirst) = filters
                reader.timeline(view.scope, unreadOnly, oldestFirst, view.keepIds, view.limit).map {
                    Timeline(view.scope, oldestFirst, it)
                }
            }
            .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)

    /**
     * Returns once [scope]'s entries have loaded (after [select]ing it): at once if they're the
     * ones loaded already. Whether it had to wait, i.e. there's a new list to draw.
     */
    suspend fun awaitLoaded(scope: ListScope): Boolean {
        if (timeline.value?.scope == scope) return false
        timeline.first { it?.scope == scope }
        return true
    }

    private val _search = MutableStateFlow<String?>(null)

    /** What's typed in the search box; null when not searching. */
    val search: StateFlow<String?> = _search.asStateFlow()

    /** Articles on the device matching [search], newest first; null when not searching. */
    val searchResults: StateFlow<List<TimelineItem>?> =
        _search
            // Not a query per keystroke while typing fast.
            .debounce { if (it.isNullOrEmpty()) 0L else 150L }
            .flatMapLatest { text ->
                if (text == null) flowOf(null) else reader.search(text, SEARCH_LIMIT)
            }
            .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)

    fun setSearch(text: String?) {
        _search.value = text
    }

    /** The ids of the list on screen (search results while searching), for paging through. */
    fun shownIds(): List<String> =
        (if (_search.value != null) searchResults.value else timeline.value?.items).orEmpty().map {
            it.id
        }

    init {
        refresh()
    }

    fun select(scope: ListScope) {
        view.update { it.select(scope) }
    }

    fun loadMore() {
        view.update { it.loadMore() }
    }

    private val _shown = MutableStateFlow<String?>(null)

    /** The article open (beside the list, on a wide screen), to show it as selected. */
    val shown: StateFlow<String?> = _shown.asStateFlow()

    fun opened(id: String) {
        _shown.value = id
        view.update { it.keep(id) }
    }

    fun shownClosed() {
        _shown.value = null
    }

    fun setUnreadOnly(value: Boolean) {
        view.update { it.letGoOfKept() }
        viewModelScope.launch { updateSettings { it.copy(unreadOnly = value) } }
    }

    fun setOldestFirst(value: Boolean) {
        viewModelScope.launch { updateSettings { it.copy(oldestFirst = value) } }
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
        view.update { it.keep(item.id) }
        viewModelScope.launch { reader.setRead(listOf(item.id), !item.read) }
    }

    fun toggleStar(item: TimelineItem) {
        view.update { it.keep(item.id) }
        viewModelScope.launch { reader.setStarred(item.id, !item.starred) }
    }

    /** The entries mark-all-read would mark, taken when the user is asked to confirm. */
    suspend fun unreadInList(): List<String> = reader.unreadIds(view.value.scope)

    fun markRead(ids: List<String>) {
        view.update { it.letGoOfKept() }
        viewModelScope.launch { reader.setRead(ids, true) }
    }

    /**
     * Pulling to refresh also lets go of the read entries kept in an unread-only list, as choosing
     * the list again does (but not the article open beside it).
     */
    fun pullToRefresh() {
        view.update { it.letGoOfKept(except = _shown.value) }
        refresh()
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
                        if (e.failure() == ApiFailure.SignedOut) "Signed out"
                        else "Sync failed (${e.status})"
                    )
                } catch (_: IOException) {
                    SyncStatus.Failed("Offline — showing saved articles")
                } catch (_: Exception) {
                    // Token endpoint 5xx, a captive portal's HTML, a DB error:
                    // report it, never crash the screen.
                    SyncStatus.Failed("Sync failed")
                }
        }
    }
}
