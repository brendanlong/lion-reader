package com.lionreader.shared.account

import app.cash.sqldelight.db.SqlDriver
import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import com.lionreader.shared.data.AppSchema
import com.lionreader.shared.sync.RetentionPolicy
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.MockRequestHandleScope
import io.ktor.client.engine.mock.respond
import io.ktor.client.engine.mock.respondError
import io.ktor.client.request.HttpRequestData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.OutgoingContent
import io.ktor.http.headersOf
import io.ktor.http.parseUrlEncodedParameters
import java.io.File
import java.nio.file.Files
import java.util.Collections
import java.util.Properties
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotSame
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout

/** [Accounts] against a fake server: sign-in, sign-out, and switching accounts. */
class AccountsTest {
    private val requests: MutableList<String> = Collections.synchronizedList(mutableListOf())

    /** Refreshing a token fails as for a revoked one: an involuntary sign-out. */
    @Volatile private var refreshDead = false

    /** While set, /auth/me waits for it. */
    @Volatile private var meGate: CompletableDeferred<Unit>? = null

    /** While set, /auth/me fails as the server being down. */
    @Volatile private var meDown = false

    private val http =
        HttpClient(
            MockEngine { request ->
                requests += "${request.method.value} ${request.url.encodedPath}"
                when (request.url.encodedPath) {
                    "/oauth/token" -> {
                        val form = form(request)
                        if (form["grant_type"] == "refresh_token" && refreshDead) {
                            respondError(HttpStatusCode.BadRequest)
                        } else {
                            // The code (or refresh token) names the user.
                            val user = form["code"] ?: form["refresh_token"]!!.removePrefix("r-")
                            json(
                                """{"access_token":"a-$user","refresh_token":"r-$user",""" +
                                    """"expires_in":3600}"""
                            )
                        }
                    }
                    "/api/v1/auth/me" -> {
                        meGate?.await()
                        if (meDown) return@MockEngine respondError(HttpStatusCode.BadGateway)
                        val user =
                            request.headers[HttpHeaders.Authorization]!!.removePrefix("Bearer a-")
                        json("""{"user":{"id":"$user","email":"$user@example.com"}}""")
                    }
                    "/oauth/revoke" -> respond("")
                    else -> respondError(HttpStatusCode.NotFound)
                }
            }
        )

    private fun form(request: HttpRequestData): Map<String, String?> {
        val text = String((request.body as OutgoingContent.ByteArrayContent).bytes())
        val parameters = text.parseUrlEncodedParameters()
        return parameters.names().associateWith { parameters[it] }
    }

    private fun MockRequestHandleScope.json(body: String) =
        respond(body, headers = headersOf(HttpHeaders.ContentType, "application/json"))

    private val store = MemoryStore()
    private val dir: File = Files.createTempDirectory("accounts").toFile()
    private val storage = FileStorage(dir)
    private val background = RecordedSync()
    private val sessionsEnded = Collections.synchronizedList(mutableListOf<Unit>())

    @AfterTest fun cleanUp() = dir.deleteRecursively().let {}

    private fun accounts(confirmRetryMillis: Long = 5_000) =
        Accounts(
            store,
            storage,
            background,
            http,
            "/oauth/app-callback",
            allowHttp = false,
            retention = { RetentionPolicy() },
            io = Dispatchers.IO,
            beforeSessionEnds = { sessionsEnded += Unit },
            confirmRetryMillis = confirmRetryMillis,
        )

    private fun until(condition: () -> Boolean) = runBlocking {
        withTimeout(5_000) {
            while (!condition()) delay(10)
        }
    }

    private fun Accounts.loseTheTokens() {
        refreshDead = true
        runBlocking {
            connection.value.auth.accessToken(forceRefresh = true, rejected = "a-alice")
        }
        refreshDead = false
    }

    private fun Accounts.signIn(user: String) {
        val request = runBlocking { startSignIn(SERVER) }
        completeSignIn("${connection.value.auth.redirectUri}?code=$user&state=${request.state}")
    }

    private fun Accounts.signInAndWait(user: String): AccountSession {
        val before = account.value
        signIn(user)
        until { account.value.let { it != null && it !== before && it.confirmed.value } }
        return account.value!!
    }

    private fun Accounts.signOutAndWait() {
        signOut()
        until { account.value == null && !connection.value.auth.signedIn.value }
    }

    @Test
    fun anAccountsDatabaseIsNamedForTheServerAndTheUser() {
        // Changing the name loses every account's data on the device.
        assertEquals(
            "account-v5-c1aba06838f2a8e074f9dd25.db",
            accounts().signInAndWait("alice").dbName,
        )
    }

    @Test
    fun signingOutDeletesTheDataAndTheTokens() {
        val accounts = accounts()
        val session = accounts.signInAndWait("alice")

        accounts.signOutAndWait()

        assertEquals(listOf(session.dbName), storage.deleted)
        assertNull(store.getString("access_token"))
        assertNull(store.getString("refresh_token"))
        assertNull(accounts.pendingAuthorization)
        assertEquals(listOf(Unit), sessionsEnded)
        until { "POST /oauth/revoke" in requests }
        until { background.calls.lastOrNull() == "schedulePeriodic" }
        assertTrue("cancelAll" in background.calls)
    }

    @Test
    fun signingBackInToTheSameAccountIsANewSession() {
        val accounts = accounts()
        val first = accounts.signInAndWait("alice")
        accounts.signOutAndWait()

        val second = accounts.signInAndWait("alice")

        assertNotSame(first, second)
        assertEquals(first.dbName, second.dbName)
        // What still holds the old one gets a cancellation, not a crash.
        assertFailsWith<CancellationException> { runBlocking { first.unsentChanges() } }
        assertEquals(0L, runBlocking { second.unsentChanges() })
    }

    /**
     * After an involuntary sign-out the account's data stays; someone else signing in must not see
     * or sync it, even before the app knows who they are, and then it goes.
     */
    @Test
    fun anotherAccountSigningInNeverGetsTheKeptOnesData() {
        val accounts = accounts()
        val alice = accounts.signInAndWait("alice")
        runBlocking { alice.reader.setStarred("entry", true) }
        accounts.loseTheTokens()
        assertFalse(accounts.connection.value.auth.signedIn.value)
        assertSame(alice, accounts.account.value)

        val gate = CompletableDeferred<Unit>().also { meGate = it }
        accounts.signIn("bob")
        // Bob's tokens are in, but nobody has asked whose they are yet.
        until { accounts.connection.value.auth.signedIn.value }
        assertSame(alice, accounts.account.value)
        assertFalse(alice.confirmed.value)
        assertEquals(AccountStatus.Confirming, accounts.accountStatus.value)

        gate.complete(Unit)
        until { accounts.account.value.let { it != null && it !== alice && it.confirmed.value } }
        val bob = accounts.account.value!!
        assertEquals(listOf(alice.dbName), storage.deleted)
        assertEquals(listOf(Unit), sessionsEnded)
        assertEquals(0L, runBlocking { bob.unsentChanges() })
    }

    @Test
    fun theSameAccountAfterAnInvoluntarySignOutKeepsItsChanges() {
        val accounts = accounts()
        val alice = accounts.signInAndWait("alice")
        runBlocking { alice.reader.setStarred("entry", true) }
        accounts.loseTheTokens()

        accounts.signIn("alice")
        until { alice.confirmed.value }

        assertSame(alice, accounts.account.value)
        assertEquals(1L, runBlocking { alice.unsentChanges() })
        assertEquals(emptyList(), storage.deleted)
    }

    @Test
    fun aSignInThatCantAskWhoItIsKeepsAskingWithoutTheScreen() {
        meDown = true
        val accounts = accounts(confirmRetryMillis = 50)
        accounts.signIn("alice")
        until { accounts.connection.value.auth.signedIn.value }
        until { requests.count { it == "GET /api/v1/auth/me" } >= 2 }
        assertEquals(AccountStatus.Confirming, accounts.accountStatus.value)

        meDown = false

        until { accounts.accountStatus.value is AccountStatus.Ready }
        assertSame(
            accounts.account.value,
            (accounts.accountStatus.value as AccountStatus.Ready).session,
        )
    }

    /** Whatever the last attempt to ask is waiting out, a sign-in asks again at once. */
    @Test
    fun aSignInAsksWhoItIsAtOnce() {
        meDown = true
        val accounts = accounts(confirmRetryMillis = 60_000)
        accounts.signIn("alice")
        until { "GET /api/v1/auth/me" in requests }
        meDown = false

        accounts.signIn("alice")

        until { accounts.accountStatus.value is AccountStatus.Ready }
    }

    @Test
    fun aNewAccountsFirstSyncIsScheduled() {
        accounts().signInAndWait("alice")

        until { "syncNow" in background.calls }
    }

    @Test
    fun aLocalChangeIsSentSoon() {
        val session = accounts().signInAndWait("alice")

        runBlocking { session.reader.setStarred("entry", true) }

        assertTrue("flushSoon" in background.calls)
    }

    @Test
    fun aRedirectForAnotherSignInDoesntCancelThisOne() {
        val accounts = accounts()
        val request = runBlocking { accounts.startSignIn(SERVER) }

        accounts.completeSignIn(
            "${accounts.connection.value.auth.redirectUri}?code=eve&state=forged"
        )

        assertEquals(request, accounts.pendingAuthorization)
        assertFalse("POST /oauth/token" in requests)
    }

    @Test
    fun startingUpKeepsOnlyTheCurrentAccountsData() {
        store.edit { putString("account_db", "account-v5-kept.db") }

        val accounts = accounts()

        assertEquals(listOf<String?>("account-v5-kept.db"), storage.keptAtStart)
        assertEquals("account-v5-kept.db", accounts.account.value?.dbName)
        // Signed out, so not shown until a sign-in says whose it is.
        assertEquals(AccountStatus.SignedOut, accounts.accountStatus.value)
    }

    @Test
    fun onlyAnHttpsServerCanBeSignedInTo() {
        assertFailsWith<IllegalArgumentException> {
            runBlocking { accounts().startSignIn("http://lionreader.example") }
        }
    }

    private class MemoryStore : KeyValueStore {
        private val values = mutableMapOf<String, Any>()

        override fun getString(key: String): String? =
            synchronized(values) { values[key] } as String?

        override fun getBoolean(key: String, default: Boolean) =
            synchronized(values) { values[key] } as Boolean? ?: default

        override fun getLong(key: String, default: Long) =
            synchronized(values) { values[key] } as Long? ?: default

        override fun edit(changes: KeyValueStore.Editor.() -> Unit) =
            synchronized(values) {
                object : KeyValueStore.Editor {
                        override fun putString(key: String, value: String?) {
                            if (value == null) values.remove(key) else values[key] = value
                        }

                        override fun putBoolean(key: String, value: Boolean) {
                            values[key] = value
                        }

                        override fun putLong(key: String, value: Long) {
                            values[key] = value
                        }

                        override fun remove(key: String) {
                            values.remove(key)
                        }
                    }
                    .changes()
            }
    }

    private class FileStorage(private val dir: File) : AccountStorage {
        val deleted: MutableList<String> = Collections.synchronizedList(mutableListOf())
        val keptAtStart = mutableListOf<String?>()

        override fun openDatabase(name: String): SqlDriver =
            JdbcSqliteDriver("jdbc:sqlite:${File(dir, name).path}", Properties(), AppSchema)

        override fun delete(name: String) {
            File(dir, name).delete()
            deleted += name
        }

        override fun deleteAllBut(keep: String?) {
            keptAtStart += keep
        }
    }

    private class RecordedSync : BackgroundSync {
        val calls: MutableList<String> = Collections.synchronizedList(mutableListOf())

        override fun flushSoon() {
            calls += "flushSoon"
        }

        override fun syncNow() {
            calls += "syncNow"
        }

        override fun schedulePeriodic() {
            calls += "schedulePeriodic"
        }

        override fun cancelAll() {
            calls += "cancelAll"
        }
    }

    private companion object {
        const val SERVER = "https://lionreader.example"
    }
}
