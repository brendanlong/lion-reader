package com.lionreader.shared.data

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import com.lionreader.shared.api.EntryMetadata
import com.lionreader.shared.api.FullEntry
import com.lionreader.shared.api.SyncEvent
import com.lionreader.shared.db.LionReaderDatabase
import com.lionreader.shared.sync.FakeServer
import com.lionreader.shared.sync.RetentionPolicy
import com.lionreader.shared.sync.SyncEngine
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.time.Instant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest

private val NOW = Instant.parse("2026-09-29T12:00:00Z").toEpochMilliseconds()

class SearchTest {
    private val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
    private val db = LionReaderDatabase(driver).also { AppSchema.create(driver) }
    private val server = FakeServer()
    private val engine = SyncEngine(server.api(), db, { NOW }, { RetentionPolicy() })
    private val reader = Reader(db, { NOW }, Dispatchers.Unconfined) {}

    @AfterTest fun close() = driver.close()

    private fun serve(id: String, hoursAgo: Long, title: String, body: String = "<p>Nothing</p>") {
        val at = Instant.fromEpochMilliseconds(NOW - hoursAgo * 3_600_000).toString()
        server.entries[id] =
            FullEntry(
                id = id,
                subscriptionId = "sub-1",
                type = "web",
                title = title,
                author = "Ada Lovelace",
                summary = "A summary about engines",
                feedTitle = "Rust Weekly",
                publishedAt = at,
                fetchedAt = at,
                read = false,
                starred = false,
                contentCleaned = body,
                fetchFullContent = false,
            )
    }

    private suspend fun search(text: String) = reader.search(text, 100).first().map { it.id }

    @Test
    fun findsEntriesByTheirWordsNewestFirst() = runTest {
        serve("old", hoursAgo = 5, title = "Borrow checker tips")
        serve("new", hoursAgo = 1, title = "Async borrow patterns")
        serve("other", hoursAgo = 2, title = "Gardening")
        engine.sync()

        assertEquals(listOf("new", "old"), search("borrow"))
        assertEquals(listOf("old"), search("BORROW checker"))
        assertEquals(listOf("new", "other", "old"), search("lovelace"))
        assertEquals(listOf("new", "other", "old"), search("engines"))
        assertEquals(listOf("new", "other", "old"), search("rust weekly"))
    }

    @Test
    fun matchesTheBodyTextNotItsMarkup() = runTest {
        serve(
            "a",
            hoursAgo = 1,
            title = "A",
            body = "<p class=\"lede\">The <b>quick</b> fox &amp; hound</p>",
        )
        engine.sync()

        assertEquals(listOf("a"), search("quick fox"))
        assertEquals(listOf("a"), search("hound"))
        assertEquals(emptyList(), search("lede"))
        assertEquals(emptyList(), search("amp"))
    }

    @Test
    fun wordsSurviveInlineTagsEntitiesAndQuotedAngleBrackets() = runTest {
        serve(
            "a",
            hoursAgo = 1,
            title = "A",
            body = "<p><img alt=\"a > b\">Fl<em>oo</em>ring caf&#233; na&#xEF;ve&mdash;done</p>",
        )
        engine.sync()

        assertEquals(listOf("a"), search("flooring"))
        assertEquals(listOf("a"), search("café naïve done"))
        assertEquals(emptyList(), search("mdash"))
        assertEquals(emptyList(), search("233"))
    }

    @Test
    fun resultsFollowBodiesArrivingAndGoing() = runTest {
        serve("a", hoursAgo = 1, title = "A", body = "<p>Hidden treasure</p>")
        engine.sync(downloadContent = false)
        val results = mutableListOf<List<String>>()
        backgroundScope.launch(Dispatchers.Unconfined) {
            reader.search("treasure", 100).collect { results += it.map { item -> item.id } }
        }
        assertEquals(emptyList(), results.last())

        engine.sync()
        assertEquals(listOf("a"), results.last())

        db.bodyQueries.deleteForEntry("a")
        assertEquals(emptyList(), results.last())
    }

    @Test
    fun matchesWordsWhileTheyAreBeingTyped() = runTest {
        serve("a", hoursAgo = 1, title = "Running the numbers")
        serve("b", hoursAgo = 2, title = "Walking")
        engine.sync()

        assertEquals(listOf("a"), search("nu"))
        assertEquals(listOf("a"), search("runn"))
        assertEquals(listOf("a"), search("running num"))
    }

    @Test
    fun followsEditsAndDeletions() = runTest {
        serve("a", hoursAgo = 1, title = "Before")
        serve("b", hoursAgo = 2, title = "Doomed")
        engine.sync()
        serve("a", hoursAgo = 1, title = "After", body = "<p>Rewritten</p>")
        server.queueChanges(
            events = listOf(SyncEvent.EntryUpdated("a", EntryMetadata(title = "After"))),
            deletions = listOf("b"),
        )

        engine.sync()

        assertEquals(emptyList(), search("before"))
        assertEquals(listOf("a"), search("after"))
        assertEquals(listOf("a"), search("rewritten"))
        assertEquals(emptyList(), search("doomed"))
    }

    @Test
    fun typedSyntaxIsJustText() = runTest {
        serve("a", hoursAgo = 1, title = "C++ and \"quotes\"")
        engine.sync()

        assertEquals(listOf("a"), search("c++"))
        assertEquals(listOf("a"), search("\"quotes"))
        assertEquals(listOf("a"), search("quotes AND"))
        assertEquals(emptyList(), search("quotes OR gardening"))
        assertEquals(emptyList(), search("*()-\""))
    }
}
