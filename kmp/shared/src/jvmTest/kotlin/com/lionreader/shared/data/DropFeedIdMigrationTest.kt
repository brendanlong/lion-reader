package com.lionreader.shared.data

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import com.lionreader.shared.db.LionReaderDatabase
import java.io.File
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals

/** 7.sqm rebuilds `entry` without `feed_id` (#1841); search must keep working across it. */
class DropFeedIdMigrationTest {
    private val file =
        File.createTempFile("schema-v7", ".db").also {
            File("src/commonMain/sqldelight/databases/7.db").copyTo(it, overwrite = true)
        }
    private val driver = JdbcSqliteDriver("jdbc:sqlite:${file.path}")

    @AfterTest
    fun close() {
        driver.close()
        file.delete()
    }

    private fun execute(sql: String) = driver.execute(null, sql, 0)

    private fun search(text: String) =
        LionReaderDatabase(driver)
            .searchQueries
            .search(searchQuery(text)!!, 100)
            .executeAsList()
            .map { it.id }

    @Test
    fun searchKeepsItsEntriesAndFollowsNewChanges() {
        // As installed: the search triggers, and rowids with a gap.
        SEARCH_TRIGGERS.forEach(::execute)
        execute(
            "INSERT INTO entry(id, feed_id, type, title, fetched_at, sort_at, read, starred, " +
                "body_version) VALUES ('a', 'f', 'web', 'Alpha', 0, 3, 0, 0, 1), " +
                "('gone', 'f', 'web', 'Gone', 0, 2, 0, 0, 2), " +
                "('b', NULL, 'web', 'Beta', 0, 1, 0, 0, 3)"
        )
        execute("DELETE FROM entry WHERE id = 'gone'")
        execute(
            "INSERT INTO entry_body(entry_id, content, size, downloaded_at, search_text) " +
                "VALUES ('b', '<p>Walrus</p>', 0, 0, 'Walrus')"
        )

        AppSchema.migrate(driver, 7, AppSchema.version)

        assertEquals(listOf("a"), search("alpha"))
        assertEquals(listOf("b"), search("walrus"))

        execute(
            "INSERT INTO entry(id, type, title, fetched_at, sort_at, read, starred, body_version) " +
                "VALUES ('c', 'web', 'Gamma', 0, 0, 0, 0, 4)"
        )
        execute("UPDATE entry SET title = 'Delta' WHERE id = 'a'")
        execute("DELETE FROM entry_body WHERE entry_id = 'b'")
        execute("DELETE FROM entry WHERE id = 'c'")

        assertEquals(listOf("a"), search("delta"))
        assertEquals(emptyList(), search("alpha"))
        assertEquals(emptyList(), search("walrus"))
        assertEquals(emptyList(), search("gamma"))
    }
}
