package com.lionreader.ui.entries

import androidx.lifecycle.SavedStateHandle
import app.cash.turbine.test
import com.lionreader.data.api.models.SortOrder
import com.lionreader.data.db.entities.EntryEntity
import com.lionreader.data.db.relations.EntryWithState
import com.lionreader.data.repository.EntryFilters
import com.lionreader.data.repository.EntryRepository
import com.lionreader.data.repository.EntrySyncResult
import com.lionreader.data.repository.SubscriptionRepository
import com.lionreader.data.repository.SyncResult
import com.lionreader.data.repository.TagRepository
import com.lionreader.data.sync.ConnectivityMonitorInterface
import com.lionreader.ui.navigation.Screen
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Unit tests for [EntryListViewModel].
 *
 * Tests cover:
 * - Filter toggling (unread only, sort order)
 * - Route-based filtering
 * - Toggle read/starred actions
 * - UI state management
 */
@OptIn(ExperimentalCoroutinesApi::class)
class EntryListViewModelTest {

    private val testDispatcher = StandardTestDispatcher()

    private lateinit var savedStateHandle: SavedStateHandle
    private lateinit var entryRepository: EntryRepository
    private lateinit var subscriptionRepository: SubscriptionRepository
    private lateinit var tagRepository: TagRepository
    private lateinit var connectivityMonitor: ConnectivityMonitorInterface

    private lateinit var viewModel: EntryListViewModel

    private val testEntry = EntryWithState(
        entry = EntryEntity(
            id = "entry-1",
            feedId = "feed-1",
            url = "https://example.com/post",
            title = "Test Entry",
            author = "Author",
            summary = "Summary",
            contentOriginal = "Content",
            contentCleaned = "Cleaned",
            publishedAt = System.currentTimeMillis(),
            fetchedAt = System.currentTimeMillis(),
            feedTitle = "Test Feed",
            lastSyncedAt = System.currentTimeMillis()
        ),
        read = false,
        starred = false,
        readAt = null,
        starredAt = null
    )

    @BeforeEach
    fun setUp() {
        Dispatchers.setMain(testDispatcher)

        savedStateHandle = SavedStateHandle()
        entryRepository = mockk(relaxed = true)
        subscriptionRepository = mockk(relaxed = true)
        tagRepository = mockk(relaxed = true)
        connectivityMonitor = mockk<ConnectivityMonitorInterface>(relaxed = true)

        // Default mock setup
        every { connectivityMonitor.isOnline } returns MutableStateFlow(true)
        every { connectivityMonitor.checkOnline() } returns true
        every { entryRepository.getEntries(any()) } returns flowOf(listOf(testEntry))
        coEvery { entryRepository.syncEntries(any(), any()) } returns EntrySyncResult(
            syncResult = SyncResult.Success,
            hasMore = false,
        )
    }

    @AfterEach
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun createViewModel(): EntryListViewModel {
        return EntryListViewModel(
            savedStateHandle = savedStateHandle,
            entryRepository = entryRepository,
            subscriptionRepository = subscriptionRepository,
            tagRepository = tagRepository,
            connectivityMonitor = connectivityMonitor,
        )
    }

    @Nested
    @DisplayName("Initial State")
    inner class InitialState {

        @Test
        @DisplayName("Initial state shows 'All' title")
        fun initialStateShowsAllTitle() = runTest {
            viewModel = createViewModel()
            testDispatcher.scheduler.advanceUntilIdle()

            assertEquals(Screen.All.TITLE, viewModel.uiState.value.title)
        }

        @Test
        @DisplayName("Initial state has default sort order newest")
        fun initialStateSortOrderNewest() = runTest {
            viewModel = createViewModel()
            testDispatcher.scheduler.advanceUntilIdle()

            assertEquals(SortOrder.NEWEST, viewModel.uiState.value.sortOrder)
        }

        @Test
        @DisplayName("Initial state unread only is false")
        fun initialStateUnreadOnlyFalse() = runTest {
            viewModel = createViewModel()
            testDispatcher.scheduler.advanceUntilIdle()

            assertFalse(viewModel.uiState.value.unreadOnly)
        }
    }

    @Nested
    @DisplayName("Filter Toggling")
    inner class FilterToggling {

        @Test
        @DisplayName("Toggle unread only updates state")
        fun toggleUnreadOnlyUpdatesState() = runTest {
            viewModel = createViewModel()
            testDispatcher.scheduler.advanceUntilIdle()

            assertFalse(viewModel.uiState.value.unreadOnly)

            viewModel.toggleUnreadOnly()
            testDispatcher.scheduler.advanceUntilIdle()

            assertTrue(viewModel.uiState.value.unreadOnly)
        }

        @Test
        @DisplayName("Toggle unread only twice returns to original")
        fun toggleUnreadOnlyTwiceReturnsToOriginal() = runTest {
            viewModel = createViewModel()
            testDispatcher.scheduler.advanceUntilIdle()

            viewModel.toggleUnreadOnly()
            testDispatcher.scheduler.advanceUntilIdle()

            viewModel.toggleUnreadOnly()
            testDispatcher.scheduler.advanceUntilIdle()

            assertFalse(viewModel.uiState.value.unreadOnly)
        }

        @Test
        @DisplayName("Toggle sort order changes between newest and oldest")
        fun toggleSortOrderChanges() = runTest {
            viewModel = createViewModel()
            testDispatcher.scheduler.advanceUntilIdle()

            assertEquals(SortOrder.NEWEST, viewModel.uiState.value.sortOrder)

            viewModel.toggleSortOrder()
            testDispatcher.scheduler.advanceUntilIdle()

            assertEquals(SortOrder.OLDEST, viewModel.uiState.value.sortOrder)

            viewModel.toggleSortOrder()
            testDispatcher.scheduler.advanceUntilIdle()

            assertEquals(SortOrder.NEWEST, viewModel.uiState.value.sortOrder)
        }

        @Test
        @DisplayName("Toggling unread resyncs entries")
        fun togglingUnreadResyncsEntries() = runTest {
            viewModel = createViewModel()
            testDispatcher.scheduler.advanceUntilIdle()

            viewModel.toggleUnreadOnly()
            testDispatcher.scheduler.advanceUntilIdle()

            // Verify syncEntries was called (at least once during init and once after toggle)
            coVerify(atLeast = 2) { entryRepository.syncEntries(any(), any()) }
        }

        @Test
        @DisplayName("Toggling sort order resyncs entries")
        fun togglingSortOrderResyncsEntries() = runTest {
            viewModel = createViewModel()
            testDispatcher.scheduler.advanceUntilIdle()

            viewModel.toggleSortOrder()
            testDispatcher.scheduler.advanceUntilIdle()

            coVerify(atLeast = 2) { entryRepository.syncEntries(any(), any()) }
        }
    }

    @Nested
    @DisplayName("Route-based Filtering")
    inner class RouteBasedFiltering {

        @Test
        @DisplayName("Setting starred route updates title")
        fun settingStarredRouteUpdatesTitle() = runTest {
            viewModel = createViewModel()
            testDispatcher.scheduler.advanceUntilIdle()

            viewModel.setRoute(Screen.Starred.route)
            testDispatcher.scheduler.advanceUntilIdle()

            assertEquals(Screen.Starred.TITLE, viewModel.uiState.value.title)
        }

        @Test
        @DisplayName("Setting feed route uses feed filter")
        fun settingFeedRouteUsesFeedFilter() = runTest {
            coEvery { subscriptionRepository.getSubscriptionByFeedId("feed-123") } returns
                mockk { every { displayTitle } returns "My Feed" }

            viewModel = createViewModel()
            testDispatcher.scheduler.advanceUntilIdle()

            viewModel.setRoute("feed/feed-123")
            testDispatcher.scheduler.advanceUntilIdle()

            assertEquals("My Feed", viewModel.uiState.value.title)
        }

        @Test
        @DisplayName("Setting tag route uses tag filter")
        fun settingTagRouteUsesTagFilter() = runTest {
            coEvery { tagRepository.getTag("tag-456") } returns
                mockk { every { name } returns "Technology" }

            viewModel = createViewModel()
            testDispatcher.scheduler.advanceUntilIdle()

            viewModel.setRoute("tag/tag-456")
            testDispatcher.scheduler.advanceUntilIdle()

            assertEquals("Technology", viewModel.uiState.value.title)
        }

        @Test
        @DisplayName("Same route is ignored")
        fun sameRouteIsIgnored() = runTest {
            viewModel = createViewModel()
            testDispatcher.scheduler.advanceUntilIdle()

            val initialCallCount = 1 // From init
            coVerify(exactly = initialCallCount) { entryRepository.syncEntries(any(), any()) }

            // Setting the same route should not trigger another sync
            viewModel.setRoute(Screen.All.route)
            testDispatcher.scheduler.advanceUntilIdle()

            coVerify(exactly = initialCallCount) { entryRepository.syncEntries(any(), any()) }
        }
    }

    @Nested
    @DisplayName("Toggle Read/Star Actions")
    inner class ToggleActions {

        @Test
        @DisplayName("Toggle read calls repository")
        fun toggleReadCallsRepository() = runTest {
            viewModel = createViewModel()
            testDispatcher.scheduler.advanceUntilIdle()

            viewModel.toggleRead("entry-1")
            testDispatcher.scheduler.advanceUntilIdle()

            coVerify { entryRepository.toggleRead("entry-1") }
        }

        @Test
        @DisplayName("Toggle star calls repository")
        fun toggleStarCallsRepository() = runTest {
            viewModel = createViewModel()
            testDispatcher.scheduler.advanceUntilIdle()

            viewModel.toggleStar("entry-1")
            testDispatcher.scheduler.advanceUntilIdle()

            coVerify { entryRepository.toggleStarred("entry-1") }
        }
    }

    @Nested
    @DisplayName("Connectivity State")
    inner class ConnectivityState {

        @Test
        @DisplayName("Initial state reflects connectivity")
        fun initialStateReflectsConnectivity() = runTest {
            every { connectivityMonitor.isOnline } returns MutableStateFlow(false)
            every { connectivityMonitor.checkOnline() } returns false

            viewModel = createViewModel()
            testDispatcher.scheduler.advanceUntilIdle()

            assertFalse(viewModel.uiState.value.isOnline)
        }

        @Test
        @DisplayName("Connectivity changes are observed")
        fun connectivityChangesAreObserved() = runTest {
            val connectivityFlow = MutableStateFlow(true)
            every { connectivityMonitor.isOnline } returns connectivityFlow
            every { connectivityMonitor.checkOnline() } returns true

            viewModel = createViewModel()
            testDispatcher.scheduler.advanceUntilIdle()

            assertTrue(viewModel.uiState.value.isOnline)

            connectivityFlow.value = false
            testDispatcher.scheduler.advanceUntilIdle()

            assertFalse(viewModel.uiState.value.isOnline)
        }
    }

    @Nested
    @DisplayName("Entries Flow")
    inner class EntriesFlow {

        @Test
        @DisplayName("Entries flow emits from repository")
        fun entriesFlowEmitsFromRepository() = runTest {
            viewModel = createViewModel()
            testDispatcher.scheduler.advanceUntilIdle()

            viewModel.entries.test {
                // First emission might be empty list (initial value), skip it
                skipItems(1)
                // Advance to let the flow emit from repository
                testDispatcher.scheduler.advanceUntilIdle()

                val entries = awaitItem()
                assertEquals(1, entries.size)
                assertEquals("entry-1", entries[0].entry.id)
            }
        }
    }

    @Nested
    @DisplayName("Refresh")
    inner class Refresh {

        @Test
        @DisplayName("Refresh sets refreshing state")
        fun refreshSetsRefreshingState() = runTest {
            viewModel = createViewModel()
            testDispatcher.scheduler.advanceUntilIdle()

            viewModel.uiState.test {
                skipItems(1) // Skip initial state

                viewModel.refresh()

                val refreshingState = awaitItem()
                assertTrue(refreshingState.isRefreshing)

                testDispatcher.scheduler.advanceUntilIdle()
                cancelAndIgnoreRemainingEvents()
            }
        }

        @Test
        @DisplayName("Refresh syncs from server when online")
        fun refreshSyncsFromServerWhenOnline() = runTest {
            every { connectivityMonitor.checkOnline() } returns true

            viewModel = createViewModel()
            testDispatcher.scheduler.advanceUntilIdle()

            viewModel.refresh()
            testDispatcher.scheduler.advanceUntilIdle()

            coVerify { entryRepository.syncFromServer() }
        }

        @Test
        @DisplayName("Refresh does not sync from server when offline")
        fun refreshDoesNotSyncFromServerWhenOffline() = runTest {
            every { connectivityMonitor.checkOnline() } returns false

            viewModel = createViewModel()
            testDispatcher.scheduler.advanceUntilIdle()

            viewModel.refresh()
            testDispatcher.scheduler.advanceUntilIdle()

            coVerify(exactly = 0) { entryRepository.syncFromServer() }
        }
    }

    @Nested
    @DisplayName("Error Handling")
    inner class ErrorHandling {

        @Test
        @DisplayName("Clear error removes error message")
        fun clearErrorRemovesMessage() = runTest {
            coEvery { entryRepository.syncEntries(any(), any()) } throws RuntimeException("Test error")

            viewModel = createViewModel()
            testDispatcher.scheduler.advanceUntilIdle()

            // Should have error from failed sync
            assertTrue(viewModel.uiState.value.errorMessage != null)

            viewModel.clearError()

            assertEquals(null, viewModel.uiState.value.errorMessage)
        }
    }

    @Nested
    @DisplayName("Load More")
    inner class LoadMore {

        @Test
        @DisplayName("Load more does nothing when already loading")
        fun loadMoreDoesNothingWhenLoading() = runTest {
            // Set up slow response to keep loading state
            coEvery { entryRepository.syncEntries(any(), any()) } coAnswers {
                kotlinx.coroutines.delay(1000)
                EntrySyncResult(syncResult = SyncResult.Success, hasMore = true)
            }

            viewModel = createViewModel()
            testDispatcher.scheduler.advanceUntilIdle()

            // Start loading more
            viewModel.loadMore()
            // Advance slightly to let the coroutine start and set _isLoadingMore = true
            testDispatcher.scheduler.advanceTimeBy(1)

            // Try to load more again - should be ignored since _isLoadingMore is now true
            viewModel.loadMore()

            testDispatcher.scheduler.advanceUntilIdle()

            // Should only have 2 calls: init sync + 1 loadMore (second loadMore was ignored)
            coVerify(exactly = 2) { entryRepository.syncEntries(any(), any()) }
        }

        @Test
        @DisplayName("Load more does nothing when no more items")
        fun loadMoreDoesNothingWhenNoMoreItems() = runTest {
            coEvery { entryRepository.syncEntries(any(), any()) } returns EntrySyncResult(
                syncResult = SyncResult.Success,
                hasMore = false,
            )

            viewModel = createViewModel()
            testDispatcher.scheduler.advanceUntilIdle()

            assertFalse(viewModel.uiState.value.hasMore)

            viewModel.loadMore()
            testDispatcher.scheduler.advanceUntilIdle()

            // Only init sync, loadMore should be skipped
            coVerify(exactly = 1) { entryRepository.syncEntries(any(), any()) }
        }
    }
}
