package com.lionreader.app.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.lionreader.app.AppGraph
import com.lionreader.shared.api.ApiException
import com.lionreader.shared.data.ListScope
import com.lionreader.shared.data.Navigation
import com.lionreader.shared.data.Reader
import com.lionreader.shared.data.TimelineItem
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

private const val PAGE = 200L

sealed interface SyncStatus {
    data object Idle : SyncStatus

    data object Syncing : SyncStatus

    data class Failed(val message: String) : SyncStatus
}

@OptIn(ExperimentalCoroutinesApi::class)
class HomeViewModel(
    private val reader: Reader,
    unreadOnlySetting: Flow<Boolean>,
    private val saveUnreadOnly: suspend (Boolean) -> Unit,
    private val sync: suspend () -> Unit,
) : ViewModel() {
    constructor(
        graph: AppGraph
    ) : this(
        graph.reader,
        graph.settings.settings.map { it.unreadOnly },
        { value -> graph.settings.update { it.copy(unreadOnly = value) } },
        { graph.session.sync.sync() },
    )

    private val _scope = MutableStateFlow<ListScope>(ListScope.All)
    val scope: StateFlow<ListScope> = _scope.asStateFlow()

    /** Entries touched since the list was chosen stay in an unread-only list. */
    private val keepIds = MutableStateFlow<Set<String>>(emptySet())
    private val limit = MutableStateFlow(PAGE)

    private val _status = MutableStateFlow<SyncStatus>(SyncStatus.Idle)
    val status: StateFlow<SyncStatus> = _status.asStateFlow()

    val unreadOnly: StateFlow<Boolean> =
        unreadOnlySetting.stateIn(viewModelScope, SharingStarted.Eagerly, true)

    val navigation: StateFlow<Navigation?> =
        reader.navigation().stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)

    val items: StateFlow<List<TimelineItem>?> =
        combine(_scope, unreadOnly, keepIds, limit) { scope, unread, keep, limit ->
                Query(scope, unread, keep, limit)
            }
            .flatMapLatest { reader.timeline(it.scope, it.unreadOnly, it.keepIds, it.limit) }
            .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)

    private data class Query(
        val scope: ListScope,
        val unreadOnly: Boolean,
        val keepIds: Set<String>,
        val limit: Long,
    )

    init {
        refresh()
    }

    fun select(scope: ListScope) {
        _scope.value = scope
        keepIds.value = emptySet()
        limit.value = PAGE
    }

    fun loadMore() {
        limit.value += PAGE
    }

    fun opened(id: String) {
        keepIds.value += id
    }

    fun setUnreadOnly(value: Boolean) {
        keepIds.value = emptySet()
        viewModelScope.launch { saveUnreadOnly(value) }
    }

    fun toggleRead(item: TimelineItem) {
        keepIds.value += item.id
        reader.setRead(listOf(item.id), !item.read)
    }

    fun toggleStar(item: TimelineItem) = reader.setStarred(item.id, !item.starred)

    fun markAllRead() {
        keepIds.value = emptySet()
        reader.markAllRead(_scope.value)
    }

    fun refresh() {
        if (_status.value == SyncStatus.Syncing) return
        _status.value = SyncStatus.Syncing
        viewModelScope.launch {
            _status.value =
                try {
                    sync()
                    SyncStatus.Idle
                } catch (e: ApiException) {
                    SyncStatus.Failed(
                        if (e.status == 0) "Signed out" else "Sync failed (${e.status})"
                    )
                } catch (e: java.io.IOException) {
                    SyncStatus.Failed("Offline — showing saved articles")
                }
        }
    }
}
