package com.lionreader.shared.data

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import com.lionreader.shared.db.LionReaderDatabase
import java.io.File
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals

/** 8.sqm: saved articles are found by their site, not their feed title "Saved Articles". */
class SavedSourceMigrationTest {
    private val file =
        File.createTempFile("schema-v8", ".db").also {
            File("src/commonMain/sqldelight/databases/8.db").copyTo(it, overwrite = true)
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
    fun savedArticlesAreIndexedUnderTheirSite() {
        // As installed at version 8, the triggers indexed COALESCE(feed_title, site_name).
        execute(
            """
            CREATE TRIGGER entry_search_insert AFTER INSERT ON entry BEGIN
              INSERT INTO entry_search(rowid, title, author, source, summary)
              VALUES (NEW.rowid, NEW.title, NEW.author, COALESCE(NEW.feed_title, NEW.site_name),
                NEW.summary);
            END
            """
        )
        execute(
            """
            CREATE TRIGGER entry_search_update AFTER UPDATE OF site_name ON entry BEGIN
              UPDATE entry_search SET source = COALESCE(NEW.feed_title, NEW.site_name)
              WHERE rowid = NEW.rowid;
            END
            """
        )
        execute(
            "INSERT INTO entry(id, type, title, site_name, feed_title, fetched_at, sort_at, " +
                "read, starred, body_version) VALUES " +
                "('saved', 'saved', 'A', 'Walrus Times', 'Saved Articles', 0, 2, 0, 0, 1), " +
                "('web', 'web', 'B', 'walrus.example', 'Rust Weekly', 0, 1, 0, 0, 2)"
        )

        AppSchema.migrate(driver, 8, AppSchema.version)

        assertEquals(listOf("saved"), search("walrus"))
        assertEquals(listOf("web"), search("rust weekly"))

        execute(
            "INSERT INTO entry(id, type, title, site_name, feed_title, fetched_at, sort_at, " +
                "read, starred, body_version) " +
                "VALUES ('new', 'saved', 'C', 'Narwhal News', 'Saved Articles', 0, 0, 0, 0, 3)"
        )
        assertEquals(listOf("new"), search("narwhal"))
        execute("UPDATE entry SET site_name = 'Otter Daily' WHERE id = 'saved'")
        assertEquals(listOf("saved"), search("otter"))
    }
}
