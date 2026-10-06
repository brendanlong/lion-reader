package com.lionreader.shared.data

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import com.lionreader.shared.db.LionReaderDatabase
import java.io.File
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** 4.sqm: bodies and summaries already on the device count as current, not to download again. */
class BodyVersionMigrationTest {
    private val file =
        File.createTempFile("schema-v4", ".db").also {
            File("src/commonMain/sqldelight/databases/4.db").copyTo(it, overwrite = true)
        }
    private val driver = JdbcSqliteDriver("jdbc:sqlite:${file.path}")

    @AfterTest
    fun close() {
        driver.close()
        file.delete()
    }

    @Test
    fun bodiesAndSummariesOnTheDeviceStayCurrent() {
        for (sql in
            listOf(
                "INSERT INTO entry(id, type, fetched_at, sort_at, read, starred, body_version) " +
                    "VALUES ('a', 'web', 0, 0, 0, 0, 7), ('b', 'web', 0, 0, 0, 0, 9)",
                "INSERT INTO entry_body(entry_id, content, size, downloaded_at, search_text) " +
                    "VALUES ('a', '<p>A</p>', 8, 0, ''), ('b', '', 0, 0, '')",
                "INSERT INTO entry_summary(entry_id, html) VALUES ('a', '<p>Short</p>')",
            )) {
            driver.execute(null, sql, 0)
        }

        AppSchema.migrate(driver, 4, AppSchema.version)

        val db = LionReaderDatabase(driver)
        assertEquals(emptyList(), db.entryQueries.selectOutdatedBodies(10).executeAsList())
        // A summary of the current body: one arriving at this version keeps it.
        db.summaryQueries.deleteOutdated("a", 7)
        assertTrue(db.entryQueries.selectById("a").executeAsOne().ai_summary != null)
    }
}
