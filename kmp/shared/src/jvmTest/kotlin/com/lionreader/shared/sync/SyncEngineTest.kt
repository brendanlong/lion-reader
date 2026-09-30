package com.lionreader.shared.sync

import app.cash.sqldelight.db.QueryResult
import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import com.lionreader.shared.api.ApiException
import com.lionreader.shared.api.EntryMetadata
import com.lionreader.shared.api.EventEntry
import com.lionreader.shared.api.FeedType
import com.lionreader.shared.api.FullEntry
import com.lionreader.shared.api.Subscription
import com.lionreader.shared.api.SyncEvent
import com.lionreader.shared.api.TagRef
import com.lionreader.shared.data.ListScope
import com.lionreader.shared.data.Reader
import com.lionreader.shared.db.LionReaderDatabase
import io.ktor.http.HttpStatusCode
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Instant
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout

private val NOW = Instant.parse("2026-09-29T12:00:00Z").toEpochMilliseconds()
private const val DAY = 24L * 60 * 60 * 1000

class SyncEngineTest {
    private val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
    private val db = LionReaderDatabase(driver).also { LionReaderDatabase.Schema.create(driver) }
    private val server = FakeServer()
    private var clock = NOW
    private var policy = RetentionPolicy()
    private val engine = SyncEngine(server.api(), db, { clock }, { policy })
    private val reader = Reader(db, { clock }, Dispatchers.Unconfined) {}

    @AfterTest fun close() = driver.close()

    private fun entry(
        id: String,
        ageDays: Long = 1,
        read: Boolean = false,
        starred: Boolean = false,
        subscriptionId: String? = "sub-1",
        type: FeedType = FeedType.WEB,
    ) =
        FullEntry(
            id = id,
            subscriptionId = subscriptionId,
            feedId = "feed-1",
            type = type,
            title = "Title $id",
            publishedAt = Instant.fromEpochMilliseconds(NOW - ageDays * DAY).toString(),
            fetchedAt = Instant.fromEpochMilliseconds(NOW - ageDays * DAY).toString(),
            read = read,
            starred = starred,
            contentCleaned = "<p>Body $id</p>",
        )

    private fun serve(vararg entries: FullEntry) {
        entries.forEach { server.entries[it.id] = it }
    }

    private suspend fun timeline(scope: ListScope = ListScope.All, unreadOnly: Boolean = false) =
        reader.timeline(scope, unreadOnly, emptySet(), 1000).first().map { it.id }

    private fun minutesAgo(minutes: Int) =
        Instant.fromEpochMilliseconds(NOW - minutes * 60_000L).toString()

    @Test
    fun bootstrapDownloadsTheWindowAndBodies() = runTest {
        server.subscriptions += Subscription("sub-1", FeedType.WEB, title = "Feed")
        serve(
            entry("a", ageDays = 1),
            entry("b", ageDays = 2, read = true),
            entry("c", ageDays = 3),
        )

        engine.sync()

        assertEquals(listOf("a", "b", "c"), timeline())
        assertEquals(listOf("a", "c"), timeline(unreadOnly = true))
        assertEquals("<p>Body a</p>", reader.entry("a").first()?.content)
        val nav = reader.navigation().first()
        assertEquals(listOf("Feed"), nav.subscriptions.map { it.title })
        assertEquals(2, nav.subscriptions.single().unread)
    }

    @Test
    fun bootstrapSavesEachPageAndResumesAfterAFailure() = runTest {
        // 250 entries, newest first: pages of 100, the second page fails once.
        repeat(250) {
            serve(entry("e%03d".format(it), ageDays = 0).copy(publishedAt = minutesAgo(it)))
        }
        server.entryPageFailures += 2

        assertFailsWith<Exception> { engine.sync(downloadContent = false) }
        // The first page — the newest entries — is already on the device.
        assertEquals((0 until 100).map { "e%03d".format(it) }, timeline())
        assertTrue(
            db.appMetadataQueries.selectValue("bootstrap_cursors").executeAsOneOrNull() != null
        )

        engine.sync(downloadContent = false)
        assertEquals(250, timeline().size)
        // Resumed with the first attempt's start cursors rather than new ones.
        assertEquals(
            1,
            server.requests.count {
                it.url.encodedPath.endsWith("/sync/changes") && it.url.parameters.isEmpty()
            },
        )
    }

    @Test
    fun localChangesShowImmediatelyAndAreSentWithTheirTime() = runTest {
        serve(entry("a"), entry("b"))
        engine.sync()
        server.subscriptions += Subscription("sub-1", FeedType.WEB)

        clock = NOW + 5_000
        reader.setRead(listOf("a"), true)
        reader.setStarred("b", true)

        assertEquals(listOf("b"), timeline(unreadOnly = true))
        assertEquals(listOf("b"), timeline(ListScope.Starred))

        clock = NOW + 60_000
        engine.flushOutbox()

        val markRead = server.markReadRequests.single()
        assertEquals(listOf("a"), markRead.entries.map { it.id })
        assertEquals("2026-09-29T12:00:05Z", markRead.entries.single().changedAt)
        assertEquals("2026-09-29T12:01:00Z", markRead.clientSentAt)
        assertEquals(listOf("b"), server.starRequests.single().entries.map { it.id })
        assertEquals(0, db.outboxQueries.countStates().executeAsOne())
        // The server's answer is now the local state.
        assertEquals(true, reader.entry("a").first()?.read)
    }

    @Test
    fun unreadCountsAreTheDevicesOwnIncludingUnsentChanges() = runTest {
        server.subscriptions += Subscription("sub-1", FeedType.WEB)
        serve(entry("a"), entry("b"))
        engine.sync()

        reader.setRead(listOf("a"), true)

        val nav = reader.navigation().first()
        assertEquals(1, nav.allUnread)
        assertEquals(1, nav.subscriptions.single().unread)
    }

    @Test
    fun unreadEntriesOutsideTheWindowAreNotCounted() = runTest {
        policy = RetentionPolicy(windowDays = 3)
        serve(entry("recent"), entry("old", ageDays = 10))

        engine.sync()

        assertEquals(1, reader.navigation().first().allUnread)
    }

    @Test
    fun aChangeMadeWhileItsFlushIsInFlightIsKept() = runTest {
        serve(entry("a"))
        engine.sync()
        reader.setRead(listOf("a"), true)
        server.duringStateWrite = {
            server.duringStateWrite = null
            clock += 1_000
            reader.setRead(listOf("a"), false)
        }

        engine.flushOutbox()

        // The newer change survives the older one's successful send.
        assertEquals(1, db.outboxQueries.countStates().executeAsOne())
        assertEquals(false, reader.entry("a").first()?.read)
    }

    @Test
    fun starredCountFollowsUnsentStarAndReadChanges() = runTest {
        serve(entry("a"), entry("b", starred = true))
        engine.sync()
        assertEquals(1, reader.navigation().first().starredUnread)

        reader.setStarred("a", true)
        assertEquals(2, reader.navigation().first().starredUnread)

        reader.setRead(listOf("b"), true)
        assertEquals(1, reader.navigation().first().starredUnread)
    }

    @Test
    fun aFailedFollowUpFetchRetriesTheWholePage() = runTest {
        engine.sync()
        server.entries["s"] = entry("s", starred = true)
        server.queueChanges(
            events = listOf(SyncEvent.EntryStateChanged("s", read = true, starred = true)),
            times = 2,
        )
        server.batchFailure = HttpStatusCode.ServiceUnavailable

        assertFailsWith<Exception> { engine.sync(downloadContent = false) }
        engine.sync(downloadContent = false)

        assertEquals(listOf("s"), timeline(ListScope.Starred))
    }

    @Test
    fun anUpdatedEntryIsDownloadedAgain() = runTest {
        serve(entry("a"))
        engine.sync()
        server.entries["a"] = entry("a").copy(contentCleaned = "<p>Revised</p>")
        server.queueChanges(
            events = listOf(SyncEvent.EntryUpdated("a", EntryMetadata(title = "Revised")))
        )

        engine.sync()

        assertEquals("<p>Revised</p>", reader.entry("a").first()?.content)
    }

    @Test
    fun transientFailureKeepsTheChange() = runTest {
        serve(entry("a"))
        engine.sync()
        reader.setRead(listOf("a"), true)

        server.stateWriteFailure = HttpStatusCode.ServiceUnavailable
        assertFailsWith<Exception> { engine.flushOutbox() }
        assertEquals(1, db.outboxQueries.countStates().executeAsOne())

        server.stateWriteFailure = null
        engine.flushOutbox()
        assertEquals(0, db.outboxQueries.countStates().executeAsOne())
    }

    @Test
    fun rejectedChangeIsDroppedInsteadOfBlockingTheQueue() = runTest {
        serve(entry("a"), entry("b"))
        engine.sync()
        reader.setRead(listOf("a"), true)

        server.stateWriteFailure = HttpStatusCode.BadRequest
        engine.flushOutbox()

        assertEquals(0, db.outboxQueries.countStates().executeAsOne())
    }

    @Test
    fun entryMissingFromTheServerAnswerIsRemovedLocally() = runTest {
        serve(entry("a"))
        engine.sync()
        reader.setRead(listOf("a"), true)
        server.entries.remove("a")

        engine.flushOutbox()

        assertNull(reader.entry("a").first())
    }

    @Test
    fun pullAppliesEventsAndDeletions() = runTest {
        serve(entry("a"), entry("b"))
        engine.sync()
        server.queueChanges(
            events =
                listOf(
                    SyncEvent.NewEntry(
                        entryId = "c",
                        subscriptionId = "sub-1",
                        feedId = "feed-1",
                        feedType = FeedType.WEB,
                        entry = EventEntry(title = "New", fetchedAt = "2026-09-29T11:00:00Z"),
                    ),
                    SyncEvent.EntryStateChanged(
                        entryId = "a",
                        read = true,
                        starred = true,
                    ),
                ),
            deletions = listOf("b"),
        )

        engine.sync(downloadContent = false)

        assertEquals(listOf("c", "a"), timeline())
        assertEquals(listOf("a"), timeline(ListScope.Starred))
        assertEquals(1, reader.navigation().first().allUnread)
    }

    @Test
    fun aNewEntryEventForAnEntryOnTheDeviceReplacesItsBody() = runTest {
        // Created after the bootstrap's start cursor, so the device lists it
        // (and downloads its body) before the pull reports it as new — by
        // which time it may have been edited (#1680).
        serve(entry("a"))
        engine.sync()
        serve(entry("a").copy(contentCleaned = "<p>Edited</p>"))
        server.queueChanges(
            events =
                listOf(
                    SyncEvent.NewEntry(
                        entryId = "a",
                        subscriptionId = "sub-1",
                        feedId = "feed-1",
                        feedType = FeedType.WEB,
                        entry = EventEntry(title = "Title a", fetchedAt = "2026-09-28T12:00:00Z"),
                    )
                )
        )

        engine.sync()

        assertEquals("<p>Edited</p>", reader.entry("a").first()?.content)
    }

    @Test
    fun unknownEventTypesAreSkipped() = runTest {
        engine.sync()
        server.changes.addLast(
            com.lionreader.shared.api.SyncChanges(
                events =
                    listOf(
                        kotlinx.serialization.json.buildJsonObject {
                            put("type", kotlinx.serialization.json.JsonPrimitive("from_the_future"))
                        }
                    ),
                hasMore = false,
                cursors = server.cursors,
            )
        )

        engine.sync(downloadContent = false)
    }

    @Test
    fun unsubscribingDropsUnstarredEntriesOfThatFeed() = runTest {
        serve(entry("a"), entry("b", starred = true))
        engine.sync()
        server.queueChanges(events = listOf(SyncEvent.SubscriptionDeleted("sub-1")))

        engine.sync(downloadContent = false)

        assertEquals(listOf("b"), timeline())
    }

    @Test
    fun resyncKeepsUnsentChanges() = runTest {
        serve(entry("a"))
        engine.sync()
        reader.setStarred("a", true)
        server.stateWriteFailure = HttpStatusCode.ServiceUnavailable
        server.queueChanges(resyncRequired = true)

        assertFailsWith<Exception> { engine.sync() }
        server.stateWriteFailure = null
        engine.sync()

        assertEquals(listOf("a"), timeline(ListScope.Starred))
        assertTrue(server.entries.getValue("a").starred)
    }

    @Test
    fun retentionDropsOldEntriesButKeepsStarredAndSaved() = runTest {
        policy = RetentionPolicy(windowDays = 3)
        serve(
            entry("recent", ageDays = 1),
            entry("old", ageDays = 5),
            entry("old-starred", ageDays = 5, starred = true),
            entry("old-saved", ageDays = 5, type = FeedType.SAVED, subscriptionId = null),
        )

        engine.sync()

        assertEquals(setOf("recent", "old-starred", "old-saved"), timeline().toSet())
    }

    @Test
    fun markAllReadMarksTheEntriesOnTheDeviceAndSendsThem() = runTest {
        server.subscriptions += Subscription("sub-1", FeedType.WEB)
        server.subscriptions += Subscription("sub-2", FeedType.WEB)
        serve(
            entry("a", ageDays = 1),
            entry("b", ageDays = 2),
            entry("c", subscriptionId = "sub-2"),
        )
        engine.sync()

        assertEquals(2, reader.navigation().first().subscriptions.first { it.id == "sub-1" }.unread)
        val ids = reader.unreadIds(ListScope.Subscription("sub-1"))
        assertEquals(setOf("a", "b"), ids.toSet())
        reader.setRead(ids, true)

        assertEquals(listOf("c"), timeline(unreadOnly = true))
        engine.flushOutbox()
        assertEquals(
            setOf("a", "b"),
            server.markReadRequests.single().entries.map { it.id }.toSet(),
        )
    }

    @Test
    fun uncategorizedHoldsFeedsWithoutATag() = runTest {
        server.subscriptions +=
            Subscription("sub-1", FeedType.WEB, tags = listOf(TagRef("tag-1", "News")))
        server.subscriptions += Subscription("sub-2", FeedType.WEB)
        serve(
            entry("tagged"),
            entry("untagged", subscriptionId = "sub-2"),
            entry("saved", subscriptionId = null, type = FeedType.SAVED),
        )
        engine.sync()

        assertEquals(listOf("untagged"), timeline(ListScope.Uncategorized))
        assertEquals(listOf("untagged"), reader.unreadIds(ListScope.Uncategorized))
    }

    @Test
    fun openingAnEntryDoesNotWaitForTheBackgroundDownload() = runTest {
        server.subscriptions += Subscription("sub-1", FeedType.WEB)
        serve(entry("a"), entry("b"))
        engine.sync(downloadContent = false)

        // The background download stalls on a slow batch.
        val stalled = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        server.duringBatch = { ids ->
            if (ids.size > 1) {
                stalled.complete(Unit)
                release.await()
            }
        }
        val background = launch { engine.sync() }
        stalled.await()

        // Real time: the fake server answers on its own threads.
        withContext(Dispatchers.Default) { withTimeout(5_000) { engine.ensureContent("b") } }
        assertEquals("<p>Body b</p>", reader.entry("b").first()?.content)

        release.complete(Unit)
        background.join()
    }

    @Test
    fun summariesAreKeptUntilTheArticleChanges() = runTest {
        server.subscriptions += Subscription("sub-1", FeedType.WEB)
        serve(entry("a"))
        server.summaries["a"] = "<p>Short version</p>"
        engine.sync()

        assertTrue(engine.summariesAvailable())
        engine.summarize("a")
        assertEquals("<p>Short version</p>", reader.entry("a").first()?.summary)
        engine.sync()
        assertEquals("<p>Short version</p>", reader.entry("a").first()?.summary)

        // An edit makes the summary stale.
        server.queueChanges(
            events = listOf(SyncEvent.EntryUpdated("a", EntryMetadata(title = "New title")))
        )
        engine.sync()
        assertNull(reader.entry("a").first()?.summary)
    }

    @Test
    fun aSummaryRequestedBeforeAnEditIsNotKept() = runTest {
        server.subscriptions += Subscription("sub-1", FeedType.WEB)
        serve(entry("a"))
        server.summaries["a"] = "<p>Of the old text</p>"
        engine.sync()

        server.duringSummary = {
            server.queueChanges(
                events = listOf(SyncEvent.EntryUpdated("a", EntryMetadata(title = "Edited")))
            )
            engine.sync(downloadContent = false)
        }
        engine.summarize("a")

        assertNull(reader.entry("a").first()?.summary)
    }

    @Test
    fun unsubscribingTakesTheSummariesWithIt() = runTest {
        server.subscriptions += Subscription("sub-1", FeedType.WEB)
        serve(entry("a"))
        server.summaries["a"] = "<p>Summary</p>"
        engine.sync()
        engine.summarize("a")

        server.queueChanges(events = listOf(SyncEvent.SubscriptionDeleted("sub-1")))
        engine.sync(downloadContent = false)

        assertEquals(0L, summaryRows())
    }

    private fun summaryRows(): Long =
        driver
            .executeQuery(
                null,
                "SELECT count(*) FROM entry_summary",
                { cursor ->
                    cursor.next()
                    QueryResult.Value(cursor.getLong(0) ?: 0L)
                },
                0,
            )
            .value

    @Test
    fun aFailedSummaryStoresNothing() = runTest {
        server.subscriptions += Subscription("sub-1", FeedType.WEB)
        serve(entry("a"))
        engine.sync()

        assertFailsWith<ApiException> { engine.summarize("a") }
        assertNull(reader.entry("a").first()?.summary)
    }
}
