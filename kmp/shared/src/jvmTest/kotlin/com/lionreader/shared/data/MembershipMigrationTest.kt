package com.lionreader.shared.data

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import com.lionreader.shared.db.LionReaderDatabase
import com.lionreader.shared.sync.RetentionPolicy
import com.lionreader.shared.sync.SyncWriter
import java.io.File
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest

private const val NOW = 1_800_000_000_000L
private const val DAY = 24L * 60 * 60 * 1000

/**
 * 5.sqm: after upgrading with no network, Saved, collections, tags, counts and what retention keeps
 * are what they were, for saved articles synced before #1885 (no subscription) and after it (the
 * Saved subscription's id).
 */
class MembershipMigrationTest {
    private val file =
        File.createTempFile("schema-v5", ".db").also {
            File("src/commonMain/sqldelight/databases/5.db").copyTo(it, overwrite = true)
        }
    private val driver = JdbcSqliteDriver("jdbc:sqlite:${file.path}")

    @AfterTest
    fun close() {
        driver.close()
        file.delete()
    }

    private fun entry(
        id: String,
        subscriptionId: String?,
        ageDays: Long,
        read: Boolean,
        type: String = "web",
    ): String {
        val sortAt = NOW - ageDays * DAY
        val sub = subscriptionId?.let { "'$it'" } ?: "NULL"
        return "INSERT INTO entry(id, subscription_id, type, fetched_at, sort_at, read, starred, " +
            "body_version) VALUES ('$id', $sub, '$type', $sortAt, $sortAt, ${if (read) 1 else 0}, 0, 1)"
    }

    @Test
    fun listsCountsAndRetentionAreWhatTheyWereOffline() = runTest {
        for (sql in
            listOf(
                "INSERT INTO subscription(id, title) VALUES ('sub-1', 'Feed'), " +
                    "('sub-2', 'Other'), ('col-1', 'Col')",
                "INSERT INTO tag(id, name) VALUES ('t-1', 'Tag')",
                "INSERT INTO subscription_tag(subscription_id, tag_id) " +
                    "VALUES ('sub-1', 't-1'), ('col-1', 't-1')",
                entry("a", "sub-1", ageDays = 1, read = false),
                entry("b", "sub-1", ageDays = 5, read = true),
                entry("c", null, ageDays = 5, read = true),
                entry("d", "sub-2", ageDays = 1, read = false),
                entry("s1", null, ageDays = 5, read = true, type = "saved"),
                entry("s2", "saved-sub", ageDays = 2, read = false, type = "saved"),
                "INSERT INTO collection_entry(subscription_id, entry_id) VALUES ('col-1', 'c')",
                "INSERT INTO app_metadata(key, value) VALUES ('collections_listed', '1')",
            )) {
            driver.execute(null, sql, 0)
        }

        AppSchema.migrate(driver, 5, AppSchema.version)

        val db = LionReaderDatabase(driver)
        val reader = Reader(db, { NOW }, Dispatchers.Unconfined) {}
        suspend fun list(scope: ListScope) =
            reader.timeline(scope, false, ListSort.NEWEST, emptySet(), 100).first().map { it.id }

        assertEquals(listOf("s2", "s1"), list(ListScope.Saved))
        assertEquals(listOf("c"), list(ListScope.Subscription("col-1")))
        assertEquals(listOf("a", "b"), list(ListScope.Subscription("sub-1")))
        assertEquals(listOf("a", "c", "b"), list(ListScope.Tag("t-1")))
        assertEquals(listOf("d"), list(ListScope.Uncategorized))
        val nav = reader.navigation().first()
        assertEquals(1, nav.savedUnread)
        assertEquals(1, nav.tags.single().unread)
        assertEquals(
            mapOf("col-1" to 0, "sub-1" to 1, "sub-2" to 1),
            nav.subscriptions.associate { it.id to it.unread },
        )

        // Saved and collections' articles are kept, bodies included.
        val writer = SyncWriter(db)
        writer.evict(RetentionPolicy(windowDays = 3), NOW)
        assertEquals(setOf("a", "c", "d", "s1", "s2"), list(ListScope.All).toSet())
        assertEquals(setOf("a", "c", "d", "s1", "s2"), writer.missingBodies(100).keys)

        // The next sync lists collections again, and knows Saved's server id.
        val store = LocalStore(db)
        assertEquals(false, store.collectionsListed)
        assertEquals("saved-sub", store.savedServerId)
        store.upsertEntry(
            "s3",
            "saved-sub",
            "saved",
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            "2026-01-01T00:00:00Z",
            false,
            false,
            null,
            listOf("saved-sub"),
            rankings = null,
        )
        assertEquals(listOf("s2", "s1", "s3"), list(ListScope.Saved))
    }

    @Test
    fun savedArticlesFromBefore1885LeaveTheSavedSubscriptionUnknown() {
        driver.execute(null, entry("s1", null, ageDays = 1, read = false, type = "saved"), 0)

        AppSchema.migrate(driver, 5, AppSchema.version)

        assertNull(LocalStore(LionReaderDatabase(driver)).savedServerId)
    }
}
