package com.lionreader.shared.sync

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import com.lionreader.shared.api.ApiJson
import com.lionreader.shared.api.LionReaderApi
import com.lionreader.shared.api.ListFilter
import com.lionreader.shared.api.MarkReadRequest
import com.lionreader.shared.api.SetStarredRequest
import com.lionreader.shared.api.StateChange
import com.lionreader.shared.auth.AppAuth
import com.lionreader.shared.auth.StoredTokens
import com.lionreader.shared.auth.TokenStore
import com.lionreader.shared.data.ListScope
import com.lionreader.shared.data.Reader
import com.lionreader.shared.db.LionReaderDatabase
import io.ktor.client.HttpClient
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.time.Instant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.Serializable
import org.junit.Assume.assumeTrue

@Serializable
private data class Fixture(
    val serverUrl: String,
    val accessToken: String,
    val refreshToken: String,
    val entryIds: List<String>,
)

/**
 * The shared core against a real server and database, over real HTTP. `LION_READER_TEST_FIXTURE` is
 * the output of `pnpm app:test-fixture` run against the server's database; without it the test is
 * skipped.
 */
class RealServerTest {
    @Test
    fun offlineChangesSyncAndConflictsResolveByChangeTime() = runBlocking {
        val raw = System.getenv("LION_READER_TEST_FIXTURE")
        assumeTrue("LION_READER_TEST_FIXTURE not set", !raw.isNullOrBlank())
        val fixture = ApiJson.decodeFromString(Fixture.serializer(), raw!!)
        val (first, second, third) = fixture.entryIds

        val http = HttpClient()
        val tokens =
            object : TokenStore {
                var value: StoredTokens? =
                    StoredTokens(
                        fixture.accessToken,
                        fixture.refreshToken,
                        System.currentTimeMillis() + 30 * 60_000,
                    )

                override fun load() = value

                override fun save(tokens: StoredTokens?) {
                    value = tokens
                }
            }
        val api =
            LionReaderApi(http, AppAuth(fixture.serverUrl, http, tokens, System::currentTimeMillis))
        var deviceClock = System.currentTimeMillis()
        JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY).use { driver ->
            LionReaderDatabase.Schema.create(driver)
            val db = LionReaderDatabase(driver)
            val engine = SyncEngine(api, db, { deviceClock }, { RetentionPolicy() })
            val reader = Reader(db, { deviceClock }, Dispatchers.Unconfined) {}
            suspend fun local(scope: ListScope = ListScope.All, unreadOnly: Boolean = false) =
                reader.timeline(scope, unreadOnly, emptySet(), 100).first().map { it.id }.toSet()
            suspend fun serverUnread() =
                api.listEntries(ListFilter.ALL, null)
                    .items
                    .filterNot { it.read }
                    .map { it.id }
                    .toSet()

            // First sync downloads the window, bodies included.
            engine.sync()
            assertEquals(fixture.entryIds.toSet(), local())
            assertEquals(
                "<p>Body of fixture entry 1</p>",
                reader.entry(first).first()?.content?.trim(),
            )

            // Offline, the user reads the first entry; ten minutes later (and
            // before this device reconnects) another device marks it unread.
            // The later change wins, even though it reaches the server first.
            deviceClock -= 10 * 60_000
            reader.setRead(listOf(first), true)
            deviceClock += 10 * 60_000
            val now = Instant.fromEpochMilliseconds(System.currentTimeMillis()).toString()
            api.markRead(
                MarkReadRequest(listOf(StateChange(first, now)), read = true, clientSentAt = now)
            )
            api.markRead(
                MarkReadRequest(listOf(StateChange(first, now)), read = false, clientSentAt = now)
            )

            engine.sync()
            assertEquals(true, first in serverUnread())
            assertEquals(true, first in local(unreadOnly = true))

            // A change made on another device arrives through the delta sync.
            api.setStarred(
                SetStarredRequest(listOf(StateChange(second)), starred = true, clientSentAt = now)
            )
            engine.sync()
            assertEquals(setOf(second), local(ListScope.Starred))

            // A change made here reaches the server.
            reader.setRead(listOf(third), true)
            engine.sync()
            assertEquals(false, third in serverUnread())
        }
    }
}
