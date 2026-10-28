package com.lionreader.shared.data

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import com.lionreader.shared.db.LionReaderDatabase
import java.io.File
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals

/** 11.sqm rebuilds `entry_body` without `search_text`; bodies and their search must survive it. */
class BodyTextMigrationTest {
    private val file =
        File.createTempFile("schema-v11", ".db").also {
            File("src/commonMain/sqldelight/databases/11.db").copyTo(it, overwrite = true)
        }
    private val driver = JdbcSqliteDriver("jdbc:sqlite:${file.path}")
    private val db = LionReaderDatabase(driver)

    @AfterTest
    fun close() {
        driver.close()
        file.delete()
    }

    private fun execute(sql: String) = driver.execute(null, sql, 0)

    private fun search(text: String) =
        db.searchQueries.search(searchQuery(text)!!, 100).executeAsList().map { it.id }

    @Test
    fun bodiesKeepTheirTextInTheIndexAndLeaveItWhenTheyGo() {
        // As installed at version 11: bodies reached the index through a column.
        SEARCH_TRIGGERS.forEach(::execute)
        execute(
            """
            CREATE TRIGGER entry_search_body AFTER INSERT ON entry_body BEGIN
              UPDATE entry_search SET body = NEW.search_text
              WHERE rowid = (SELECT rowid FROM entry WHERE id = NEW.entry_id);
              UPDATE entry_body SET search_text = '' WHERE entry_id = NEW.entry_id;
            END
            """
        )
        execute(
            "INSERT INTO entry(id, type, title, fetched_at, sort_at, read, starred, body_version) " +
                "VALUES ('a', 'web', 'Alpha', 0, 2, 0, 0, 1), ('b', 'web', 'Beta', 0, 1, 0, 0, 2)"
        )
        execute(
            "INSERT INTO entry_body(entry_id, content, size, downloaded_at, search_text, " +
                "body_version) VALUES ('a', '<p>Walrus</p>', 12, 5, 'Walrus', 1), " +
                "('b', '<p>Narwhal</p>', 14, 6, 'Narwhal', 2)"
        )

        AppSchema.migrate(driver, 11, AppSchema.version)

        assertEquals("<p>Walrus</p>", db.bodyQueries.content("a").executeAsOne())
        assertEquals(1L, db.bodyQueries.stored("a").executeAsOne().body_version)
        assertEquals(listOf("a"), search("walrus"))
        db.bodyQueries.deleteForEntry("b")
        assertEquals(emptyList(), search("narwhal"))
    }
}
