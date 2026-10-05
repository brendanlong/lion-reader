package com.lionreader.shared.sync

import app.cash.sqldelight.db.QueryResult
import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import com.lionreader.shared.api.ApiException
import com.lionreader.shared.api.COLLECTION_TYPE
import com.lionreader.shared.api.EntryMetadata
import com.lionreader.shared.api.EventEntry
import com.lionreader.shared.api.FullEntry
import com.lionreader.shared.api.Subscription
import com.lionreader.shared.api.SyncEvent
import com.lionreader.shared.api.TagRef
import com.lionreader.shared.data.AppSchema
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
    private val db = LionReaderDatabase(driver).also { AppSchema.create(driver) }
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
        type: String = "web",
    ) =
        FullEntry(
            id = id,
            subscriptionId = subscriptionId,
            type = type,
            title = "Title $id",
            publishedAt = Instant.fromEpochMilliseconds(NOW - ageDays * DAY).toString(),
            fetchedAt = Instant.fromEpochMilliseconds(NOW - ageDays * DAY).toString(),
            read = read,
            starred = starred,
            contentCleaned = "<p>Body $id</p>",
            fetchFullContent = false,
        )

    private fun subscription(id: String, title: String? = null, tags: List<TagRef> = emptyList()) =
        Subscription(id, title = title, originalTitle = title, tags = tags)

    private fun serve(vararg entries: FullEntry) {
        entries.forEach { server.entries[it.id] = it }
    }

    private suspend fun timeline(
        scope: ListScope = ListScope.All,
        unreadOnly: Boolean = false,
        oldestFirst: Boolean = false,
        limit: Long = 1000,
    ) = reader.timeline(scope, unreadOnly, oldestFirst, emptySet(), limit).first().map { it.id }

    private fun minutesAgo(minutes: Int) =
        Instant.fromEpochMilliseconds(NOW - minutes * 60_000L).toString()

    @Test
    fun bootstrapDownloadsTheWindowAndBodies() = runTest {
        server.subscriptions += subscription("sub-1", title = "Feed")
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
        server.subscriptions += subscription("sub-1")

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
    fun recentlyReadIsTheServersOrderWithUnsentChangesOnTop() = runTest {
        // Recently read on the server, but older than its window: still shown.
        serve(
            entry("old", ageDays = 400, read = true).copy(readChangedAt = minutesAgo(10)),
            entry("a", read = true).copy(readChangedAt = minutesAgo(30)),
            entry("b", read = true).copy(readChangedAt = minutesAgo(20)),
            entry("c"),
        )
        engine.sync()
        assertEquals(listOf("old", "b", "a"), timeline(ListScope.RecentlyRead))

        // Offline: the device's own changes are newer than anything the server said.
        clock = NOW + 1_000
        reader.setRead(listOf("c"), true)
        clock = NOW + 2_000
        reader.setRead(listOf("a"), false)
        assertEquals(listOf("a", "c", "old", "b"), timeline(ListScope.RecentlyRead))

        // Sent, the order holds: the server's acknowledgement records the times.
        engine.flushOutbox()
        assertEquals(listOf("a", "c", "old", "b"), timeline(ListScope.RecentlyRead))
    }

    @Test
    fun recentlyReadPagesBackThroughTheWindowThenUntilWhatItSawLastTime() = runTest {
        repeat(150) {
            serve(
                entry("r%03d".format(it), ageDays = 400, read = true)
                    .copy(readChangedAt = minutesAgo(it))
            )
        }
        val longAgo = Instant.fromEpochMilliseconds(NOW - 400 * DAY).toString()
        serve(entry("before", ageDays = 400, read = true).copy(readChangedAt = longAgo))
        fun limits() =
            server.requests
                .filter { it.url.parameters["sortBy"] == "readChanged" }
                .map { it.url.parameters["limit"] }

        engine.sync(downloadContent = false)
        // Read before the window: retention would drop it.
        val all = (0 until 150).map { "r%03d".format(it) }
        assertEquals(all, timeline(ListScope.RecentlyRead))
        assertEquals(listOf("20", "100", "100"), limits())

        // Read again elsewhere, which isn't a change to sync: the refresh brings them.
        val reread = (149 downTo 120).map { "r%03d".format(it) }
        reread.forEachIndexed { i, id ->
            server.entries[id] =
                server.entries.getValue(id).copy(readChangedAt = minutesAgo(-30 + i))
        }
        engine.sync(downloadContent = false)
        assertEquals(reread + all.take(120), timeline(ListScope.RecentlyRead))
        assertEquals(listOf("20", "100", "100", "20", "100"), limits())

        // Nothing new: one short page.
        engine.sync(downloadContent = false)
        assertEquals(listOf("20", "100", "100", "20", "100", "20"), limits())
    }

    @Test
    fun unreadCountsAreTheDevicesOwnIncludingUnsentChanges() = runTest {
        server.subscriptions += subscription("sub-1")
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
                        feedType = "web",
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
                        feedType = "web",
                        entry = EventEntry(title = "Title a", fetchedAt = "2026-09-28T12:00:00Z"),
                    )
                )
        )

        engine.sync()

        assertEquals("<p>Edited</p>", reader.entry("a").first()?.content)
    }

    @Test
    fun aDownloadStartedBeforeAResyncIsNotStored() = runTest {
        serve(entry("a"))
        engine.sync(downloadContent = false)

        // While the body is downloading, the entry is edited and a resync
        // deletes and re-adds it. The download's answer predates the edit.
        var batches = 0
        server.duringBatch = {
            serve(entry("a").copy(contentCleaned = "<p>Edited</p>"))
            if (++batches == 1) {
                server.queueChanges(resyncRequired = true)
                engine.sync(downloadContent = false)
                serve(entry("a"))
            }
        }
        engine.ensureContent("a")

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
                deletions = emptyList(),
                resyncRequired = false,
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

    /** sub-1 and the collection col-1 tagged t-1; col-1 holds a (of sub-1) and c (of no feed). */
    private fun serveCollection() {
        val tag = TagRef("t-1", "Tag")
        server.subscriptions += subscription("sub-1", title = "Feed", tags = listOf(tag))
        server.subscriptions +=
            Subscription("col-1", type = COLLECTION_TYPE, title = "Col", tags = listOf(tag))
        // c is older than the window: a collection's articles are kept anyway.
        serve(entry("a"), entry("b", ageDays = 2), entry("c", ageDays = 400, subscriptionId = null))
        server.collections["col-1"] = mutableSetOf("a", "c")
    }

    private suspend fun unread(scope: ListScope) = timeline(scope, unreadOnly = true)

    @Test
    fun aCollectionListsAndCountsItsArticles() = runTest {
        serveCollection()

        engine.sync()

        assertEquals(listOf("a", "c"), timeline(ListScope.Subscription("col-1")))
        assertEquals(listOf("a", "b"), timeline(ListScope.Subscription("sub-1")))
        assertEquals(listOf("a", "b", "c"), timeline(ListScope.Tag("t-1")))
        assertEquals("<p>Body c</p>", reader.entry("c").first()?.content)
        val nav = reader.navigation().first()
        assertEquals(2, nav.subscriptions.single { it.id == "col-1" }.unread)
        // a is in both of the tag's subscriptions and counts once.
        assertEquals(3, nav.tags.single().unread)
        assertEquals(listOf("a", "c"), reader.unreadIds(ListScope.Subscription("col-1")).sorted())
    }

    @Test
    fun syncFollowsArticlesJoiningAndLeavingACollection() = runTest {
        serveCollection()
        engine.sync()

        server.queueChanges(
            events =
                listOf("a", "b").map {
                    SyncEvent.EntryStateChanged(it, read = false, starred = false)
                },
            memberships = mapOf("a" to emptyList(), "b" to listOf("col-1")),
        )
        engine.sync(downloadContent = false)

        assertEquals(listOf("b", "c"), unread(ListScope.Subscription("col-1")))
        assertEquals(3, reader.navigation().first().tags.single().unread)
    }

    @Test
    fun unsubscribingKeepsEntriesInACollection() = runTest {
        serveCollection()
        engine.sync()

        // b joins the collection in the same page as its feed's unsubscribe.
        server.queueChanges(
            events =
                listOf(
                    SyncEvent.EntryStateChanged("b", read = false, starred = false),
                    SyncEvent.SubscriptionDeleted("sub-1"),
                ),
            memberships = mapOf("b" to listOf("col-1")),
        )
        engine.sync(downloadContent = false)

        assertEquals(listOf("a", "b", "c"), timeline())
        // Their feed is gone, and the collection is tagged.
        assertEquals(emptyList(), timeline(ListScope.Uncategorized))
    }

    @Test
    fun theBudgetKeepsCollectionArticlesBodies() = runTest {
        serveCollection()
        engine.sync()
        reader.setRead(listOf("a", "b", "c"), true)

        policy = RetentionPolicy(contentBudgetBytes = ("<p>Body c</p>" + "Body c").length.toLong())
        engine.sync()

        assertEquals("<p>Body c</p>", reader.entry("c").first()?.content)
        assertEquals("<p>Body a</p>", reader.entry("a").first()?.content)
        assertNull(reader.entry("b").first()?.content)
    }

    @Test
    fun deletingACollectionForgetsItsArticles() = runTest {
        serveCollection()
        engine.sync()

        // The server reports what the collection alone kept visible.
        server.queueChanges(
            events = listOf(SyncEvent.SubscriptionDeleted("col-1")),
            deletions = listOf("c"),
        )
        engine.sync(downloadContent = false)

        assertEquals(listOf("a", "b"), timeline())
        assertEquals(emptyList(), timeline(ListScope.Subscription("col-1")))
    }

    @Test
    fun aDatabaseThatPredatesCollectionsListsThemOnce() = runTest {
        serveCollection()
        engine.sync()
        db.appMetadataQueries.delete("collections_listed")
        server.collections["col-1"] = mutableSetOf("b")
        server.requests.clear()

        engine.sync(downloadContent = false)
        engine.sync(downloadContent = false)

        assertEquals(listOf("b"), timeline(ListScope.Subscription("col-1")))
        assertEquals(
            1,
            server.requests.count { it.url.parameters["subscriptionId"] == "col-1" },
        )
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
            entry("old-saved", ageDays = 5, type = "saved", subscriptionId = null),
        )

        engine.sync()

        assertEquals(setOf("recent", "old-starred", "old-saved"), timeline().toSet())
    }

    @Test
    fun markAllReadMarksTheEntriesOnTheDeviceAndSendsThem() = runTest {
        server.subscriptions += subscription("sub-1")
        server.subscriptions += subscription("sub-2")
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
        server.subscriptions += subscription("sub-1", tags = listOf(TagRef("tag-1", "News")))
        server.subscriptions += subscription("sub-2")
        serve(
            entry("tagged"),
            entry("untagged", subscriptionId = "sub-2"),
            entry("saved", subscriptionId = null, type = "saved"),
        )
        engine.sync()

        assertEquals(listOf("untagged"), timeline(ListScope.Uncategorized))
        assertEquals(listOf("untagged"), reader.unreadIds(ListScope.Uncategorized))
    }

    @Test
    fun timelineCountIsTheWholeListPastTheLimit() = runTest {
        server.subscriptions += subscription("sub-1", tags = listOf(TagRef("tag-1", "News")))
        server.subscriptions += subscription("sub-2")
        serve(
            entry("a", ageDays = 1),
            entry("b", ageDays = 1, read = true, starred = true),
            entry("c", ageDays = 2, subscriptionId = "sub-2"),
            entry("d", ageDays = 3, read = true, subscriptionId = "sub-2")
                .copy(readChangedAt = minutesAgo(10)),
            entry("e", ageDays = 4, subscriptionId = null, type = "saved")
                .copy(readChangedAt = minutesAgo(20)),
        )
        engine.sync()

        val scopes =
            listOf(
                ListScope.All,
                ListScope.Starred,
                ListScope.Saved,
                ListScope.Subscription("sub-2"),
                ListScope.Tag("tag-1"),
                ListScope.Uncategorized,
                ListScope.RecentlyRead,
            )
        for (scope in scopes) {
            for (unreadOnly in listOf(false, true)) {
                for (keepIds in listOf(emptySet(), setOf("b", "d"))) {
                    val all = reader.timeline(scope, unreadOnly, false, keepIds, 1000).first()
                    assertEquals(
                        all.size.toLong(),
                        reader.timelineCount(scope, unreadOnly, keepIds).first(),
                        "$scope, unreadOnly=$unreadOnly, keepIds=$keepIds",
                    )
                }
            }
        }
        assertEquals(5, reader.timelineCount(ListScope.All, false, emptySet()).first())
    }

    @Test
    fun oldestFirstIsEachListReversedAndPagesFromTheOldest() = runTest {
        server.subscriptions += subscription("sub-1", tags = listOf(TagRef("tag-1", "News")))
        server.subscriptions += subscription("sub-2")
        serve(
            entry("a", ageDays = 1),
            // Same time as "a": the id breaks the tie, the other way round too.
            entry("b", ageDays = 1, read = true, starred = true),
            entry("c", ageDays = 2, subscriptionId = "sub-2"),
            entry("d", ageDays = 3, read = true, subscriptionId = "sub-2")
                .copy(readChangedAt = minutesAgo(10)),
            entry("e", ageDays = 4, subscriptionId = null, type = "saved")
                .copy(readChangedAt = minutesAgo(20)),
        )
        engine.sync()

        val scopes =
            listOf(
                ListScope.All,
                ListScope.Starred,
                ListScope.Saved,
                ListScope.Subscription("sub-2"),
                ListScope.Tag("tag-1"),
                ListScope.Uncategorized,
                ListScope.RecentlyRead,
            )
        for (scope in scopes) {
            for (unreadOnly in listOf(false, true)) {
                val newest = timeline(scope, unreadOnly)
                assertEquals(
                    newest.reversed(),
                    timeline(scope, unreadOnly, oldestFirst = true),
                    "$scope, unreadOnly=$unreadOnly",
                )
            }
        }
        assertEquals(listOf("e", "d"), timeline(oldestFirst = true, limit = 2))
        assertEquals(listOf("e"), timeline(ListScope.RecentlyRead, oldestFirst = true, limit = 1))
    }

    @Test
    fun openingAnEntryDoesNotWaitForTheBackgroundDownload() = runTest {
        server.subscriptions += subscription("sub-1")
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
        server.subscriptions += subscription("sub-1")
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
        server.subscriptions += subscription("sub-1")
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
        server.subscriptions += subscription("sub-1")
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
        server.subscriptions += subscription("sub-1")
        serve(entry("a"))
        engine.sync()

        assertFailsWith<ApiException> { engine.summarize("a") }
        assertNull(reader.entry("a").first()?.summary)
    }

    @Test
    fun theBudgetKeepsARecentlyOpenedBody() = runTest {
        server.subscriptions += subscription("sub-1")
        serve(entry("old", ageDays = 3), entry("new", ageDays = 1))
        engine.sync()
        reader.setRead(listOf("old", "new"), true)
        // Oldest read goes first, unless it was just opened (it may be on screen).
        reader.markOpened("old")

        // Room for one body: its HTML and its text in the search index.
        policy =
            RetentionPolicy(contentBudgetBytes = ("<p>Body old</p>" + "Body old").length.toLong())
        engine.sync()

        assertEquals("<p>Body old</p>", reader.entry("old").first()?.content)
        assertNull(reader.entry("new").first()?.content)
    }

    private fun requests(path: String) =
        server.requests.filter { it.url.encodedPath.endsWith(path) }

    @Test
    fun aPageMentioningMoreEntriesThanOneBatchFetchTakesSeveral() = runTest {
        engine.sync()
        // More than /entries/batch takes at once (the fake, like the server, rejects that).
        val ids = (0 until 150).map { "m%03d".format(it) }
        ids.forEach { server.entries[it] = entry(it, read = true, starred = true) }
        server.queueChanges(
            events = ids.map { SyncEvent.EntryStateChanged(it, read = true, starred = true) }
        )

        engine.sync(downloadContent = false)

        assertEquals(ids.toSet(), timeline(ListScope.Starred).toSet())
        assertEquals(2, requests("/entries/batch").size)
    }

    @Test
    fun everyPageOfACatchUpIsSentWhereItStartedEvenAfterAnInterruption() = runTest {
        serve(entry("a"))
        engine.sync()
        val start = server.cursors.entries
        server.queueChanges(
            events = listOf(SyncEvent.EntryStateChanged("a", read = true, starred = false)),
            hasMore = true,
            entriesCursor = "2026-02-01T00:00:00Z",
        )
        // The second page fails once, on fetching the entry it brings.
        serve(entry("b", read = true, starred = true))
        server.queueChanges(
            events =
                listOf(
                    SyncEvent.EntryStateChanged("a", read = false, starred = true),
                    SyncEvent.EntryStateChanged("b", read = true, starred = true),
                ),
            entriesCursor = "2026-03-01T00:00:00Z",
            times = 2,
        )
        server.batchFailure = HttpStatusCode.ServiceUnavailable
        val batchesBefore = requests("/entries/batch").size

        assertFailsWith<ApiException> { engine.sync(downloadContent = false) }
        engine.sync(downloadContent = false)
        engine.sync(downloadContent = false)

        assertEquals(
            listOf(
                start to start,
                start to start,
                "2026-02-01T00:00:00Z" to start,
                "2026-02-01T00:00:00Z" to start,
                // Caught up: the next pull starts a catch-up of its own.
                "2026-03-01T00:00:00Z" to "2026-03-01T00:00:00Z",
            ),
            requests("/sync/changes")
                .filter { it.url.parameters["entries"] != null }
                .map { it.url.parameters["entries"] to it.url.parameters["entriesSince"] },
        )
        // Only the entry the device lacked was fetched (twice: the first try failed).
        assertEquals(2, requests("/entries/batch").size - batchesBefore)
        assertEquals(setOf("a", "b"), timeline(ListScope.Starred).toSet())
    }

    @Test
    fun spamIsLeftOutAsTheServersListsLeaveItOut() = runTest {
        engine.sync()
        serve(entry("spam"), entry("spam-changed"))
        // Without their data: that's how the server marks spam.
        server.queueChanges(
            events =
                listOf(
                    SyncEvent.NewEntry("spam", "sub-1", "web", entry = null),
                    SyncEvent.EntryStateChanged("spam-changed", read = false, starred = false),
                )
        )

        engine.sync(downloadContent = false)

        assertEquals(emptyList(), timeline())
        assertTrue(requests("/entries/batch").isEmpty())
    }

    @Test
    fun anEntryOfATypeNewerThanTheAppIsKeptAsNotSaved() = runTest {
        serve(
            entry("new-type", type = "podcast"),
            entry("saved", subscriptionId = null, type = "saved"),
        )

        engine.sync()

        assertEquals(setOf("new-type", "saved"), timeline().toSet())
        assertEquals(listOf("saved"), timeline(ListScope.Saved))
        assertEquals(1, reader.navigation().first().savedUnread)
    }

    @Test
    fun entryEventsWithoutAFeedTypeTakeTheEntrysOwnType() = runTest {
        engine.sync()
        // Not on the server any more, so only the events can add them.
        server.queueChanges(
            events =
                listOf(
                    SyncEvent.NewEntry(
                        "new",
                        subscriptionId = null,
                        feedType = null,
                        entry = EventEntry(type = "saved", fetchedAt = "2026-09-29T11:00:00Z"),
                    ),
                    SyncEvent.EntryStateChanged(
                        "unread-again",
                        read = false,
                        starred = false,
                        subscriptionId = "sub-1",
                        feedType = null,
                        entry = EventEntry(type = "web", fetchedAt = "2026-09-29T10:00:00Z"),
                    ),
                )
        )

        engine.sync(downloadContent = false)

        assertEquals(listOf("new", "unread-again"), timeline())
        assertEquals(listOf("new"), timeline(ListScope.Saved))
    }

    @Test
    fun aNewEntryEventWithoutAnyTypeFetchesTheEntryWhole() = runTest {
        engine.sync()
        serve(entry("untyped", type = "saved", subscriptionId = null))
        val fetched = mutableListOf<String>()
        server.duringBatch = { fetched += it }
        server.queueChanges(
            events =
                listOf(
                    SyncEvent.NewEntry(
                        "untyped",
                        "sub-1",
                        feedType = null,
                        entry = EventEntry(fetchedAt = "2026-09-29T11:00:00Z"),
                    )
                )
        )

        engine.sync(downloadContent = false)

        assertEquals(listOf("untyped"), fetched)
        assertEquals(listOf("untyped"), timeline(ListScope.Saved))
    }

    @Test
    fun aFailedSendStillPullsAndThenFails() = runTest {
        serve(entry("a"))
        engine.sync()
        reader.setRead(listOf("a"), true)
        server.stateWriteFailure = HttpStatusCode.ServiceUnavailable
        fun newEntry(id: String) =
            SyncEvent.NewEntry(
                id,
                "sub-1",
                "web",
                EventEntry(title = id, fetchedAt = "2026-09-29T11:00:00Z"),
            )

        server.queueChanges(events = listOf(newEntry("b")))
        assertFailsWith<ApiException> { engine.flushOutbox() }
        server.queueChanges(events = listOf(newEntry("c")))
        assertFailsWith<ApiException> { engine.sync() }

        assertEquals(setOf("a", "b", "c"), timeline().toSet())
        assertEquals(1, db.outboxQueries.countStates().executeAsOne())
    }

    @Test
    fun aKnownEventThatDoesNotParseFailsThePageInsteadOfBeingSkipped() = runTest {
        engine.sync()
        server.changes.addLast(
            com.lionreader.shared.api.SyncChanges(
                events =
                    listOf(
                        kotlinx.serialization.json.buildJsonObject {
                            put("type", kotlinx.serialization.json.JsonPrimitive("entry_updated"))
                            put("entryId", kotlinx.serialization.json.JsonPrimitive("a"))
                        }
                    ),
                hasMore = false,
                cursors = server.cursors.copy(entries = "2026-02-01T00:00:00Z"),
                deletions = emptyList(),
                resyncRequired = false,
            )
        )

        assertFailsWith<kotlinx.serialization.SerializationException> {
            engine.sync(downloadContent = false)
        }
        engine.sync(downloadContent = false)

        // The cursor didn't move past it.
        assertEquals(
            server.cursors.entries,
            requests("/sync/changes").last().url.parameters["entries"],
        )
    }

    @Test
    fun clearingACustomTitleShowsTheFeedsOwn() = runTest {
        server.subscriptions +=
            Subscription("sub-1", title = "Mine", originalTitle = "Theirs", tags = emptyList())
        engine.sync()
        server.queueChanges(
            events =
                listOf(
                    SyncEvent.SubscriptionCreated(
                        com.lionreader.shared.api.EventSubscription(
                            "sub-2",
                            customTitle = "Also mine",
                            tags = emptyList(),
                        ),
                        com.lionreader.shared.api.EventFeed(title = "Also theirs"),
                    )
                )
        )
        engine.sync(downloadContent = false)
        suspend fun titles() = reader.navigation().first().subscriptions.map { it.title }.sorted()
        assertEquals(listOf("Also mine", "Mine"), titles())

        server.queueChanges(
            events =
                listOf(
                    SyncEvent.SubscriptionUpdated("sub-1", emptyList(), customTitle = null),
                    SyncEvent.SubscriptionUpdated("sub-2", emptyList(), customTitle = null),
                )
        )
        engine.sync(downloadContent = false)

        assertEquals(listOf("Also theirs", "Theirs"), titles())
    }

    @Test
    fun aChangeUndoneAtTheSameMomentAsItsFlushIsKept() = runTest {
        serve(entry("a"))
        engine.sync()
        reader.setRead(listOf("a"), true)
        // Same clock reading, other value.
        server.duringStateWrite = {
            server.duringStateWrite = null
            reader.setRead(listOf("a"), false)
        }

        engine.flushOutbox()

        assertEquals(1, db.outboxQueries.countStates().executeAsOne())
        assertEquals(false, reader.entry("a").first()?.read)
    }
}
