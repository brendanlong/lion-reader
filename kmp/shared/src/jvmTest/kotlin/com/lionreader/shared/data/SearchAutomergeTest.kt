package com.lionreader.shared.data

import app.cash.sqldelight.db.QueryResult
import app.cash.sqldelight.db.SqlDriver
import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals

/** The search index merges incrementally however the database came to be. */
class SearchAutomergeTest {
    /** The index's automerge setting, which FTS4 keeps in its `_stat` table under id 2. */
    private fun SqlDriver.automerge(): Long? =
        executeQuery(
                null,
                "SELECT value FROM entry_search_stat WHERE id = 2",
                { cursor ->
                    QueryResult.Value(if (cursor.next().value) cursor.getLong(0) else null)
                },
                0,
            )
            .value

    @Test
    fun aNewDatabaseHasIt() {
        JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY).use { driver ->
            AppSchema.create(driver)
            assertEquals(AUTOMERGE_SEGMENTS.toLong(), driver.automerge())
        }
    }

    @Test
    fun aMigratedDatabaseHasIt() {
        val file =
            File.createTempFile("schema-v1", ".db").also {
                File("src/commonMain/sqldelight/databases/1.db").copyTo(it, overwrite = true)
            }
        try {
            JdbcSqliteDriver("jdbc:sqlite:${file.path}").use { driver ->
                AppSchema.migrate(driver, 1, AppSchema.version)
                assertEquals(AUTOMERGE_SEGMENTS.toLong(), driver.automerge())
            }
        } finally {
            file.delete()
        }
    }
}
