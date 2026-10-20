package com.lionreader.shared.data

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import com.lionreader.shared.db.LionReaderDatabase
import java.io.File
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest

/**
 * 10.sqm: entries and memberships on the device stay as they were, without scores or positions, and
 * the next sync lists the collections and the scored entries for theirs.
 */
class RankingsMigrationTest {
    private val file =
        File.createTempFile("schema-v10", ".db").also {
            File("src/commonMain/sqldelight/databases/10.db").copyTo(it, overwrite = true)
        }
    private val driver = JdbcSqliteDriver("jdbc:sqlite:${file.path}")

    @AfterTest
    fun close() {
        driver.close()
        file.delete()
    }

    @Test
    fun theNextSyncListsCollectionsAndScores() = runTest {
        for (sql in
            listOf(
                "INSERT INTO entry(id, type, fetched_at, sort_at, read, starred, body_version) " +
                    "VALUES ('a', 'web', 0, 2, 0, 0, 1), ('b', 'web', 0, 1, 0, 0, 1)",
                "INSERT INTO subscription(id, title, type) VALUES ('col-1', 'Col', 'collection')",
                "INSERT INTO subscription_entry(subscription_id, entry_id) " +
                    "VALUES ('col-1', 'a'), ('col-1', 'b')",
                "INSERT INTO app_metadata(key, value) VALUES ('collections_listed', '1')",
            )) {
            driver.execute(null, sql, 0)
        }

        AppSchema.migrate(driver, 10, AppSchema.version)

        val db = LionReaderDatabase(driver)
        val store = LocalStore(db)
        assertEquals(false, store.collectionsListed)
        assertEquals(false, store.scoresListed)
        val reader = Reader(db, { 0L }, Dispatchers.Unconfined) {}
        suspend fun list(scope: ListScope, sort: ListSort) =
            reader.timeline(scope, false, sort, emptySet(), 100).first().map { it.id }
        assertEquals(listOf("a", "b"), list(ListScope.All, ListSort.LOWEST))
        assertEquals(listOf("a", "b"), list(ListScope.Subscription("col-1"), ListSort.FIRST))

        // What the sync then stores, a release's database or a new one alike.
        db.entryQueries.updateScore(1.0, "b")
        db.subscriptionEntryQueries.setPosition(1.0, "col-1", "b")
        assertEquals(listOf("b", "a"), list(ListScope.All, ListSort.HIGHEST))
        assertEquals(listOf("b", "a"), list(ListScope.Subscription("col-1"), ListSort.FIRST))
        // entry_view's columns are where the queries expect them.
        assertEquals(2L, reader.entry("a").first()?.sortAtMillis)
    }
}
