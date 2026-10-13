package com.lionreader.shared.data

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import com.lionreader.shared.db.LionReaderDatabase
import java.io.File
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals

/** 6.sqm: entries synced before a rename take their subscription's current title (#1856). */
class FeedTitleMigrationTest {
    private val file =
        File.createTempFile("schema-v6", ".db").also {
            File("src/commonMain/sqldelight/databases/6.db").copyTo(it, overwrite = true)
        }
    private val driver = JdbcSqliteDriver("jdbc:sqlite:${file.path}")

    @AfterTest
    fun close() {
        driver.close()
        file.delete()
    }

    @Test
    fun entriesTakeTheirSubscriptionsTitle() {
        for (sql in
            listOf(
                "INSERT INTO subscription(id, title, original_title) VALUES ('sub-1', 'Mine', 'Theirs')",
                "INSERT INTO entry(id, subscription_id, type, feed_title, fetched_at, sort_at, " +
                    "read, starred, body_version) VALUES " +
                    "('a', 'sub-1', 'web', 'Theirs', 0, 0, 0, 0, 1), " +
                    "('saved', 'saved-sub', 'saved', 'Example', 0, 0, 0, 0, 2)",
            )) {
            driver.execute(null, sql, 0)
        }

        AppSchema.migrate(driver, 6, AppSchema.version)

        val entries = LionReaderDatabase(driver).entryQueries
        assertEquals("Mine", entries.selectById("a").executeAsOne().feed_title)
        // Saved isn't a stored subscription: its entries keep their source.
        assertEquals("Example", entries.selectById("saved").executeAsOne().feed_title)
    }
}
