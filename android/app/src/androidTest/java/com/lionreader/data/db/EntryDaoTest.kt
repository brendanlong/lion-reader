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
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Integration tests for [EntryDao] using an in-memory Room database.
 *
 * Tests verify that:
 * - Entries can be inserted and queried
 * - Filtering by feed, read/unread, starred works correctly
 * - Sorting by newest/oldest works correctly
 * - Entry states are properly joined
 */
@RunWith(AndroidJUnit4::class)
class EntryDaoTest {

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

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        database = Room.inMemoryDatabaseBuilder(context, LionReaderDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        entryDao = database.entryDao()
        entryStateDao = database.entryStateDao()
        subscriptionDao = database.subscriptionDao()
    }

    @After
    fun tearDown() {
        database.close()
    }

    private fun createEntry(
        id: String,
        feedId: String = "feed-1",
        publishedAt: Long? = System.currentTimeMillis(),
    ): EntryEntity {
        return EntryEntity(
            id = id,
            feedId = feedId,
            url = "https://example.com/$id",
            title = "Entry $id",
            author = "Author",
            summary = "Summary for $id",
            contentOriginal = "Content",
            contentCleaned = "Cleaned content",
            publishedAt = publishedAt,
            fetchedAt = System.currentTimeMillis(),
            feedTitle = "Test Feed",
            lastSyncedAt = System.currentTimeMillis()
        )
    }

    private suspend fun setupFeedAndSubscription() {
        subscriptionDao.insertFeeds(listOf(testFeed))
        subscriptionDao.insertAll(listOf(testSubscription))
    }

    @Test
    fun insertAndQueryEntries() = runTest {
        setupFeedAndSubscription()

        val entries = listOf(
            createEntry("entry-1"),
            createEntry("entry-2"),
            createEntry("entry-3"),
        )
        entryDao.insertEntries(entries)

        val result = entryDao.getEntries(
            feedId = null,
            tagId = null,
            unreadOnly = false,
            starredOnly = false,
            sortOrder = "newest",
            limit = 10,
            offset = 0,
        ).first()

        assertEquals(3, result.size)
    }

    @Test
    fun filterByFeedId() = runTest {
        // Create two feeds
        val feed2 = testFeed.copy(id = "feed-2", title = "Feed 2")
        subscriptionDao.insertFeeds(listOf(testFeed, feed2))
        subscriptionDao.insertAll(
            listOf(
                testSubscription,
                testSubscription.copy(id = "sub-2", feedId = "feed-2")
            )
        )

        // Insert entries for both feeds
        entryDao.insertEntries(
            listOf(
                createEntry("entry-1", feedId = "feed-1"),
                createEntry("entry-2", feedId = "feed-1"),
                createEntry("entry-3", feedId = "feed-2"),
            )
        )

        // Query only feed-1 entries
        val result = entryDao.getEntries(
            feedId = "feed-1",
            tagId = null,
            unreadOnly = false,
            starredOnly = false,
            sortOrder = "newest",
            limit = 10,
            offset = 0,
        ).first()

        assertEquals(2, result.size)
        assertTrue(result.all { it.entry.feedId == "feed-1" })
    }

    @Test
    fun filterByUnreadOnly() = runTest {
        setupFeedAndSubscription()

        val entries = listOf(
            createEntry("entry-1"),
            createEntry("entry-2"),
            createEntry("entry-3"),
        )
        entryDao.insertEntries(entries)

        // Mark entry-1 as read
        entryStateDao.upsertState(
            EntryStateEntity(
                entryId = "entry-1",
                read = true,
                starred = false,
                readAt = System.currentTimeMillis(),
                starredAt = null,
                pendingSync = false,
                lastModifiedAt = System.currentTimeMillis()
            )
        )

        // Query unread only
        val result = entryDao.getEntries(
            feedId = null,
            tagId = null,
            unreadOnly = true,
            starredOnly = false,
            sortOrder = "newest",
            limit = 10,
            offset = 0,
        ).first()

        // Should only have 2 entries (entry-2 and entry-3 which are unread by default)
        assertEquals(2, result.size)
        assertTrue(result.none { it.entry.id == "entry-1" })
    }

    @Test
    fun filterByStarredOnly() = runTest {
        setupFeedAndSubscription()

        val entries = listOf(
            createEntry("entry-1"),
            createEntry("entry-2"),
            createEntry("entry-3"),
        )
        entryDao.insertEntries(entries)

        // Star entry-2
        entryStateDao.upsertState(
            EntryStateEntity(
                entryId = "entry-2",
                read = false,
                starred = true,
                readAt = null,
                starredAt = System.currentTimeMillis(),
                pendingSync = false,
                lastModifiedAt = System.currentTimeMillis()
            )
        )

        // Query starred only
        val result = entryDao.getEntries(
            feedId = null,
            tagId = null,
            unreadOnly = false,
            starredOnly = true,
            sortOrder = "newest",
            limit = 10,
            offset = 0,
        ).first()

        assertEquals(1, result.size)
        assertEquals("entry-2", result[0].entry.id)
        assertTrue(result[0].isStarred)
    }

    @Test
    fun sortByNewest() = runTest {
        setupFeedAndSubscription()

        val now = System.currentTimeMillis()
        val entries = listOf(
            createEntry("entry-oldest").copy(id = "entry-oldest"),
            createEntry("entry-middle").copy(id = "entry-middle"),
            createEntry("entry-newest").copy(id = "entry-newest"),
        )
        entryDao.insertEntries(entries)

        val result = entryDao.getEntries(
            feedId = null,
            tagId = null,
            unreadOnly = false,
            starredOnly = false,
            sortOrder = "newest",
            limit = 10,
            offset = 0,
        ).first()

        // Should be sorted by ID descending (UUIDv7 ordering)
        assertEquals(3, result.size)
        // The order depends on the ID string order
        assertEquals("entry-oldest", result[0].entry.id)
    }

    @Test
    fun sortByOldest() = runTest {
        setupFeedAndSubscription()

        val entries = listOf(
            createEntry("entry-a"),
            createEntry("entry-b"),
            createEntry("entry-c"),
        )
        entryDao.insertEntries(entries)

        val result = entryDao.getEntries(
            feedId = null,
            tagId = null,
            unreadOnly = false,
            starredOnly = false,
            sortOrder = "oldest",
            limit = 10,
            offset = 0,
        ).first()

        assertEquals(3, result.size)
        assertEquals("entry-a", result[0].entry.id)
    }

    @Test
    fun paginationWithLimitAndOffset() = runTest {
        setupFeedAndSubscription()

        // Insert 10 entries
        val entries = (1..10).map { createEntry("entry-$it") }
        entryDao.insertEntries(entries)

        // Get first page
        val page1 = entryDao.getEntries(
            feedId = null,
            tagId = null,
            unreadOnly = false,
            starredOnly = false,
            sortOrder = "oldest",
            limit = 3,
            offset = 0,
        ).first()

        assertEquals(3, page1.size)
        assertEquals("entry-1", page1[0].entry.id)
        assertEquals("entry-10", page1[1].entry.id)
        assertEquals("entry-2", page1[2].entry.id)

        // Get second page
        val page2 = entryDao.getEntries(
            feedId = null,
            tagId = null,
            unreadOnly = false,
            starredOnly = false,
            sortOrder = "oldest",
            limit = 3,
            offset = 3,
        ).first()

        assertEquals(3, page2.size)
    }

    @Test
    fun getEntryById() = runTest {
        setupFeedAndSubscription()

        val entry = createEntry("entry-test")
        entryDao.insertEntries(listOf(entry))

        val result = entryDao.getEntry("entry-test")

        assertEquals("entry-test", result?.id)
        assertEquals("Entry entry-test", result?.title)
    }

    @Test
    fun getEntryByIdNotFound() = runTest {
        val result = entryDao.getEntry("nonexistent")

        assertNull(result)
    }

    @Test
    fun getEntryWithState() = runTest {
        setupFeedAndSubscription()

        val entry = createEntry("entry-test")
        entryDao.insertEntries(listOf(entry))

        entryStateDao.upsertState(
            EntryStateEntity(
                entryId = "entry-test",
                read = true,
                starred = true,
                readAt = System.currentTimeMillis(),
                starredAt = System.currentTimeMillis(),
                pendingSync = false,
                lastModifiedAt = System.currentTimeMillis()
            )
        )

        val result = entryDao.getEntryWithState("entry-test").first()

        assertEquals("entry-test", result?.entry?.id)
        assertTrue(result?.isRead ?: false)
        assertTrue(result?.isStarred ?: false)
    }

    @Test
    fun deleteEntriesForFeed() = runTest {
        setupFeedAndSubscription()

        val entries = listOf(
            createEntry("entry-1"),
            createEntry("entry-2"),
        )
        entryDao.insertEntries(entries)

        assertEquals(2, entryDao.getEntryCountForFeed("feed-1"))

        entryDao.deleteEntriesForFeed("feed-1")

        assertEquals(0, entryDao.getEntryCountForFeed("feed-1"))
    }

    @Test
    fun getEntryCountForFeed() = runTest {
        // Create two feeds
        val feed2 = testFeed.copy(id = "feed-2", title = "Feed 2")
        subscriptionDao.insertFeeds(listOf(testFeed, feed2))
        subscriptionDao.insertAll(
            listOf(
                testSubscription,
                testSubscription.copy(id = "sub-2", feedId = "feed-2")
            )
        )

        entryDao.insertEntries(
            listOf(
                createEntry("entry-1", feedId = "feed-1"),
                createEntry("entry-2", feedId = "feed-1"),
                createEntry("entry-3", feedId = "feed-1"),
                createEntry("entry-4", feedId = "feed-2"),
            )
        )

        assertEquals(3, entryDao.getEntryCountForFeed("feed-1"))
        assertEquals(1, entryDao.getEntryCountForFeed("feed-2"))
    }
}
