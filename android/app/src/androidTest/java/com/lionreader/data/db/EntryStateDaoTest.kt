package com.lionreader.data.db

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.lionreader.data.db.dao.EntryDao
import com.lionreader.data.db.dao.EntryStateDao
import com.lionreader.data.db.dao.SubscriptionDao
import com.lionreader.data.db.entities.EntryEntity
import com.lionreader.data.db.entities.EntryStateEntity
import com.lionreader.data.db.entities.FeedEntity
import com.lionreader.data.db.entities.SubscriptionEntity
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Integration tests for [EntryStateDao] using an in-memory Room database.
 *
 * Tests verify that:
 * - Entry states can be inserted and updated
 * - Read/starred status updates work correctly
 * - Pending sync tracking works correctly
 */
@RunWith(AndroidJUnit4::class)
class EntryStateDaoTest {

    private lateinit var database: LionReaderDatabase
    private lateinit var entryDao: EntryDao
    private lateinit var entryStateDao: EntryStateDao
    private lateinit var subscriptionDao: SubscriptionDao

    private val testFeed = FeedEntity(
        id = "feed-1",
        type = "rss",
        url = "https://example.com/feed.xml",
        title = "Test Feed",
        description = "A test feed",
        siteUrl = "https://example.com",
        lastSyncedAt = System.currentTimeMillis()
    )

    private val testSubscription = SubscriptionEntity(
        id = "sub-1",
        feedId = "feed-1",
        customTitle = null,
        subscribedAt = System.currentTimeMillis(),
        unreadCount = 5,
        lastSyncedAt = System.currentTimeMillis()
    )

    private val testEntry = EntryEntity(
        id = "entry-1",
        feedId = "feed-1",
        url = "https://example.com/entry-1",
        title = "Test Entry",
        author = "Author",
        summary = "Summary",
        contentOriginal = "Content",
        contentCleaned = "Cleaned",
        publishedAt = System.currentTimeMillis(),
        fetchedAt = System.currentTimeMillis(),
        feedTitle = "Test Feed",
        lastSyncedAt = System.currentTimeMillis()
    )

    @Before
    fun setUp() = runTest {
        val context = ApplicationProvider.getApplicationContext<Context>()
        database = Room.inMemoryDatabaseBuilder(context, LionReaderDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        entryDao = database.entryDao()
        entryStateDao = database.entryStateDao()
        subscriptionDao = database.subscriptionDao()

        // Set up feed and entry for state tests
        subscriptionDao.insertFeeds(listOf(testFeed))
        subscriptionDao.insertAll(listOf(testSubscription))
        entryDao.insertEntries(listOf(testEntry))
    }

    @After
    fun tearDown() {
        database.close()
    }

    @Test
    fun insertAndGetState() = runTest {
        val state = EntryStateEntity(
            entryId = "entry-1",
            read = true,
            starred = false,
            readAt = System.currentTimeMillis(),
            starredAt = null,
            pendingSync = false,
            lastModifiedAt = System.currentTimeMillis()
        )

        entryStateDao.upsertState(state)

        val result = entryStateDao.getState("entry-1")

        assertNotNull(result)
        assertEquals("entry-1", result.entryId)
        assertTrue(result.read)
        assertFalse(result.starred)
    }

    @Test
    fun getStateReturnsNullWhenNotFound() = runTest {
        val result = entryStateDao.getState("nonexistent")

        assertNull(result)
    }

    @Test
    fun upsertStateReplacesExisting() = runTest {
        val initialState = EntryStateEntity(
            entryId = "entry-1",
            read = false,
            starred = false,
            readAt = null,
            starredAt = null,
            pendingSync = false,
            lastModifiedAt = System.currentTimeMillis()
        )
        entryStateDao.upsertState(initialState)

        val updatedState = initialState.copy(
            read = true,
            starred = true,
            readAt = System.currentTimeMillis(),
            starredAt = System.currentTimeMillis()
        )
        entryStateDao.upsertState(updatedState)

        val result = entryStateDao.getState("entry-1")

        assertNotNull(result)
        assertTrue(result.read)
        assertTrue(result.starred)
    }

    @Test
    fun markReadUpdatesReadState() = runTest {
        // Create initial unread state
        entryStateDao.upsertState(
            EntryStateEntity(
                entryId = "entry-1",
                read = false,
                starred = false,
                readAt = null,
                starredAt = null,
                pendingSync = false,
                lastModifiedAt = System.currentTimeMillis()
            )
        )

        val now = System.currentTimeMillis()
        entryStateDao.markRead(
            entryId = "entry-1",
            read = true,
            readAt = now,
            modifiedAt = now
        )

        val result = entryStateDao.getState("entry-1")

        assertNotNull(result)
        assertTrue(result.read)
        assertEquals(now, result.readAt)
        assertTrue(result.pendingSync) // Should be flagged for sync
    }

    @Test
    fun markUnreadClearsReadAt() = runTest {
        // Create initial read state
        val readAt = System.currentTimeMillis()
        entryStateDao.upsertState(
            EntryStateEntity(
                entryId = "entry-1",
                read = true,
                starred = false,
                readAt = readAt,
                starredAt = null,
                pendingSync = false,
                lastModifiedAt = System.currentTimeMillis()
            )
        )

        val now = System.currentTimeMillis()
        entryStateDao.markRead(
            entryId = "entry-1",
            read = false,
            readAt = null,
            modifiedAt = now
        )

        val result = entryStateDao.getState("entry-1")

        assertNotNull(result)
        assertFalse(result.read)
        assertNull(result.readAt)
        assertTrue(result.pendingSync)
    }

    @Test
    fun setStarredUpdatesStarredState() = runTest {
        // Create initial unstarred state
        entryStateDao.upsertState(
            EntryStateEntity(
                entryId = "entry-1",
                read = false,
                starred = false,
                readAt = null,
                starredAt = null,
                pendingSync = false,
                lastModifiedAt = System.currentTimeMillis()
            )
        )

        val now = System.currentTimeMillis()
        entryStateDao.setStarred(
            entryId = "entry-1",
            starred = true,
            starredAt = now,
            modifiedAt = now
        )

        val result = entryStateDao.getState("entry-1")

        assertNotNull(result)
        assertTrue(result.starred)
        assertEquals(now, result.starredAt)
        assertTrue(result.pendingSync)
    }

    @Test
    fun getPendingSyncEntryIds() = runTest {
        // Create entries with different sync states
        entryDao.insertEntries(
            listOf(
                testEntry.copy(id = "entry-2"),
                testEntry.copy(id = "entry-3"),
            )
        )

        entryStateDao.upsertStates(
            listOf(
                EntryStateEntity(
                    entryId = "entry-1",
                    read = true,
                    starred = false,
                    readAt = null,
                    starredAt = null,
                    pendingSync = true, // Pending
                    lastModifiedAt = System.currentTimeMillis()
                ),
                EntryStateEntity(
                    entryId = "entry-2",
                    read = false,
                    starred = false,
                    readAt = null,
                    starredAt = null,
                    pendingSync = false, // Not pending
                    lastModifiedAt = System.currentTimeMillis()
                ),
                EntryStateEntity(
                    entryId = "entry-3",
                    read = false,
                    starred = true,
                    readAt = null,
                    starredAt = null,
                    pendingSync = true, // Pending
                    lastModifiedAt = System.currentTimeMillis()
                ),
            )
        )

        val pendingIds = entryStateDao.getPendingSyncEntryIds()

        assertEquals(2, pendingIds.size)
        assertTrue(pendingIds.contains("entry-1"))
        assertTrue(pendingIds.contains("entry-3"))
        assertFalse(pendingIds.contains("entry-2"))
    }

    @Test
    fun clearPendingSyncClearsFlag() = runTest {
        entryDao.insertEntries(listOf(testEntry.copy(id = "entry-2")))

        entryStateDao.upsertStates(
            listOf(
                EntryStateEntity(
                    entryId = "entry-1",
                    read = true,
                    starred = false,
                    readAt = null,
                    starredAt = null,
                    pendingSync = true,
                    lastModifiedAt = System.currentTimeMillis()
                ),
                EntryStateEntity(
                    entryId = "entry-2",
                    read = false,
                    starred = true,
                    readAt = null,
                    starredAt = null,
                    pendingSync = true,
                    lastModifiedAt = System.currentTimeMillis()
                ),
            )
        )

        // Clear pending sync for entry-1 only
        entryStateDao.clearPendingSync(listOf("entry-1"))

        val state1 = entryStateDao.getState("entry-1")
        val state2 = entryStateDao.getState("entry-2")

        assertFalse(state1?.pendingSync ?: true)
        assertTrue(state2?.pendingSync ?: false) // Still pending
    }

    @Test
    fun getPendingSyncCount() = runTest {
        entryDao.insertEntries(
            listOf(
                testEntry.copy(id = "entry-2"),
                testEntry.copy(id = "entry-3"),
            )
        )

        entryStateDao.upsertStates(
            listOf(
                EntryStateEntity(
                    entryId = "entry-1",
                    read = true,
                    starred = false,
                    readAt = null,
                    starredAt = null,
                    pendingSync = true,
                    lastModifiedAt = System.currentTimeMillis()
                ),
                EntryStateEntity(
                    entryId = "entry-2",
                    read = false,
                    starred = false,
                    readAt = null,
                    starredAt = null,
                    pendingSync = false,
                    lastModifiedAt = System.currentTimeMillis()
                ),
                EntryStateEntity(
                    entryId = "entry-3",
                    read = false,
                    starred = true,
                    readAt = null,
                    starredAt = null,
                    pendingSync = true,
                    lastModifiedAt = System.currentTimeMillis()
                ),
            )
        )

        val count = entryStateDao.getPendingSyncCount()

        assertEquals(2, count)
    }

    @Test
    fun deleteState() = runTest {
        entryStateDao.upsertState(
            EntryStateEntity(
                entryId = "entry-1",
                read = true,
                starred = true,
                readAt = System.currentTimeMillis(),
                starredAt = System.currentTimeMillis(),
                pendingSync = false,
                lastModifiedAt = System.currentTimeMillis()
            )
        )

        assertNotNull(entryStateDao.getState("entry-1"))

        entryStateDao.deleteState("entry-1")

        assertNull(entryStateDao.getState("entry-1"))
    }

    @Test
    fun upsertStatesBatch() = runTest {
        entryDao.insertEntries(
            listOf(
                testEntry.copy(id = "entry-2"),
                testEntry.copy(id = "entry-3"),
            )
        )

        val states = listOf(
            EntryStateEntity(
                entryId = "entry-1",
                read = true,
                starred = false,
                readAt = null,
                starredAt = null,
                pendingSync = false,
                lastModifiedAt = System.currentTimeMillis()
            ),
            EntryStateEntity(
                entryId = "entry-2",
                read = false,
                starred = true,
                readAt = null,
                starredAt = null,
                pendingSync = false,
                lastModifiedAt = System.currentTimeMillis()
            ),
            EntryStateEntity(
                entryId = "entry-3",
                read = true,
                starred = true,
                readAt = null,
                starredAt = null,
                pendingSync = false,
                lastModifiedAt = System.currentTimeMillis()
            ),
        )

        entryStateDao.upsertStates(states)

        val state1 = entryStateDao.getState("entry-1")
        val state2 = entryStateDao.getState("entry-2")
        val state3 = entryStateDao.getState("entry-3")

        assertTrue(state1?.read ?: false)
        assertFalse(state1?.starred ?: true)

        assertFalse(state2?.read ?: true)
        assertTrue(state2?.starred ?: false)

        assertTrue(state3?.read ?: false)
        assertTrue(state3?.starred ?: false)
    }
}
