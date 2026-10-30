package com.lionreader.shared.sync

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import com.lionreader.shared.api.EntryListItem
import com.lionreader.shared.data.AppSchema
import com.lionreader.shared.db.LionReaderDatabase
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.time.Instant

private val NOW = Instant.parse("2026-09-29T12:00:00Z").toEpochMilliseconds()
private const val DAY = 24L * 60 * 60 * 1000

/**
 * The content budget ranks bodies in two places that must agree: `selectMissingContent` sorts in
 * SQL what's missing, and `ranked`'s stored bodies are sorted by [BodyRank].
 */
class BodyRankTest {
    private val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
    private val db = LionReaderDatabase(driver).also { AppSchema.create(driver) }
    private val writer = SyncWriter(driver)

    @AfterTest fun close() = driver.close()

    @Test
    fun missingContentIsInBodyRankOrderAndRanksAsItsStoredBodyWill() {
        val entries = buildList {
            for (starred in listOf(false, true)) for (read in listOf(false, true)) {
                if (read && !starred) continue
                for (opened in listOf(false, true)) for (ageDays in listOf(1L, 1L, 2L)) {
                    add(Triple(starred, read, opened) to ageDays)
                }
            }
        }
        val items = entries.mapIndexed { i, (flags, ageDays) ->
            val published = Instant.fromEpochMilliseconds(NOW - ageDays * DAY).toString()
            EntryListItem(
                id = "e%02d".format(i),
                subscriptionId = "sub-1",
                subscriptionIds = listOf("sub-1"),
                type = "web",
                publishedAt = published,
                fetchedAt = published,
                read = flags.second,
                starred = flags.first,
            )
        }
        writer.saveEntries(items)
        entries.forEachIndexed { i, (flags, _) ->
            if (flags.third) db.entryQueries.markOpened(NOW, items[i].id)
        }
        val openedSince = NOW - DAY

        val missing =
            db.entryQueries.selectMissingContent(openedSince, Long.MAX_VALUE).executeAsList().map {
                it.rank()
            }
        assertEquals(items.size, missing.size)
        assertEquals(missing.sorted(), missing)

        for (item in items) db.bodyQueries.put(item.id, "", 0, NOW, 0)
        val stored = db.bodyQueries.ranked(openedSince).executeAsList().map { it.rank() }
        assertEquals(missing, stored.sorted())
    }
}
