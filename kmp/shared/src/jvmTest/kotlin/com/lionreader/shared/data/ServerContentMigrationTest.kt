package com.lionreader.shared.data

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import com.lionreader.shared.db.LionReaderDatabase
import java.io.File
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals

/** 9.sqm: bodies the app picked itself are downloaded again as the server's `content`. */
class ServerContentMigrationTest {
    private val file =
        File.createTempFile("schema-v9", ".db").also {
            File("src/commonMain/sqldelight/databases/9.db").copyTo(it, overwrite = true)
        }
    private val driver = JdbcSqliteDriver("jdbc:sqlite:${file.path}")

    @AfterTest
    fun close() {
        driver.close()
        file.delete()
    }

    @Test
    fun bodiesOnTheDeviceAreOutOfDate() {
        for (sql in
            listOf(
                "INSERT INTO entry(id, type, fetched_at, sort_at, read, starred, body_version) " +
                    "VALUES ('a', 'web', 0, 1, 0, 0, 1), ('b', 'web', 0, 0, 1, 0, 2)",
                "INSERT INTO entry_body(entry_id, content, size, downloaded_at, search_text, " +
                    "body_version) VALUES ('a', '<p>A</p>', 8, 0, '', 1), ('b', '', 0, 0, '', 2)",
            )) {
            driver.execute(null, sql, 0)
        }

        AppSchema.migrate(driver, 9, AppSchema.version)

        val db = LionReaderDatabase(driver)
        assertEquals(
            mapOf("a" to 1L, "b" to 2L),
            db.entryQueries.selectOutdatedBodies(10).executeAsList().associate {
                it.id to it.body_version
            },
        )
        // Still readable offline until the download replaces it.
        assertEquals(1L, db.bodyQueries.exists("a").executeAsOne())
    }
}
