package com.lionreader.app

import android.app.Application
import android.content.ComponentName
import android.content.Context
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.work.Configuration
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.WorkManagerTestInitHelper
import com.lionreader.app.narration.NarrationService
import com.lionreader.shared.account.AccountSession
import com.lionreader.shared.narration.NarratedArticle
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.engine.mock.respondError
import io.ktor.client.request.HttpRequestData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.OutgoingContent
import io.ktor.http.headersOf
import io.ktor.http.parseUrlEncodedParameters
import java.io.File
import java.util.Collections
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * AppGraph's accounts on Android against a fake server: where their data goes, and what else ends
 * with them. The rest of the accounts' lifecycle is in the shared AccountsTest.
 */
@RunWith(AndroidJUnit4::class)
// The real Application builds its own AppGraph and schedules WorkManager.
@Config(application = Application::class)
class AccountLifecycleTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val requests: MutableList<String> = Collections.synchronizedList(mutableListOf())

    /** Refreshing a token fails as for a revoked one: an involuntary sign-out. */
    @Volatile private var refreshDead = false

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

    private fun io.ktor.client.engine.mock.MockRequestHandleScope.json(body: String) =
        respond(body, headers = headersOf(HttpHeaders.ContentType, "application/json"))

    @Before
    fun setUp() {
        WorkManagerTestInitHelper.initializeTestWorkManager(
            context,
            Configuration.Builder().setExecutor(SynchronousExecutor()).build(),
        )
    }

    private fun accountFiles() = context.databaseList().filter { it.startsWith("account-") }.toSet()

    /** Waits for [condition], running the main thread's work meanwhile (stopping narration). */
    private fun until(condition: () -> Boolean) = runBlocking {
        withTimeout(5_000) {
            while (!condition()) {
                shadowOf(Looper.getMainLooper()).idle()
                delay(10)
            }
        }
    }

    private fun AppGraph.cacheAudio(session: AccountSession): File =
        File(cloudVoiceCache(session), "chunk.mp4").apply {
            parentFile!!.mkdirs()
            writeText("audio")
        }

    private fun AppGraph.loseTheTokens() {
        refreshDead = true
        runBlocking {
            accounts.connection.value.auth.accessToken(forceRefresh = true, rejected = "a-alice")
        }
        refreshDead = false
    }

    private fun AppGraph.signInAndWait(user: String): AccountSession =
        with(accounts) {
            val before = account.value
            val request = runBlocking { startSignIn(SERVER) }
            completeSignIn("${connection.value.auth.redirectUri}?code=$user&state=${request.state}")
            until { account.value.let { it != null && it !== before && it.confirmed.value } }
            account.value!!
        }

    private fun AppGraph.signOutAndWait() {
        accounts.signOut()
        until { accounts.account.value == null && !accounts.connection.value.auth.signedIn.value }
    }

    @Test
    fun signingOutDeletesTheDataAndTheTokens() {
        val graph = AppGraph(context, http)
        val session = graph.signInAndWait("alice")
        // The file is made on first use.
        runBlocking { session.reader.setStarred("entry", true) }
        assertEquals(setOf(session.dbName), accountFiles().filter { it.endsWith(".db") }.toSet())
        val audio = graph.cacheAudio(session)

        graph.signOutAndWait()

        assertEquals(emptySet<String>(), accountFiles())
        assertFalse(audio.exists())
        val prefs = context.getSharedPreferences("auth", Context.MODE_PRIVATE)
        assertNull(prefs.getString("access_token", null))
        assertNull(prefs.getString("refresh_token", null))
        assertNull(graph.accounts.pendingAuthorization)
        until { "POST /oauth/revoke" in requests }
    }

    /**
     * Narration may be of the account's article, and its cloud voice would go on with the next
     * account's tokens: switching accounts ends it, and the audio goes with the account's data.
     */
    @Test
    fun switchingAccountsStopsNarrationAndDeletesTheAudio() {
        // Robolectric can't bind media3's session service.
        shadowOf(context as Application)
            .declareComponentUnbindable(ComponentName(context, NarrationService::class.java))
        val graph = AppGraph(context, http)
        val alice = graph.signInAndWait("alice")
        val audio = graph.cacheAudio(alice)
        graph.narrator.narrate(NarratedArticle("entry", "Title", null, listOf("One.")))
        assertNotNull(graph.narrator.state.value)
        graph.loseTheTokens()

        val bob = graph.signInAndWait("bob")

        assertNull(graph.narrator.state.value)
        assertFalse(audio.exists())
        assertNotEquals(graph.cloudVoiceCache(alice), graph.cloudVoiceCache(bob))
    }

    @Test
    fun aNewAccountsFirstSyncIsScheduled() {
        val graph = AppGraph(context, http)
        graph.signInAndWait("alice")

        until { syncNow().any { it.state == WorkInfo.State.ENQUEUED } }
    }

    private fun syncNow() =
        WorkManager.getInstance(context).getWorkInfosForUniqueWork("sync-now").get()

    @Test
    fun startingUpDeletesFilesOfAccountsThatArentTheCurrentOne() {
        listOf("account-v5-kept.db", "account-v5-orphan.db").forEach {
            context.openOrCreateDatabase(it, Context.MODE_PRIVATE, null).close()
        }
        val audio = File(context.cacheDir, "cloud-voices")
        listOf("account-v5-kept", "account-v5-orphan").forEach {
            File(audio, "$it/chunk.mp4").apply {
                parentFile!!.mkdirs()
                writeText("audio")
            }
        }
        context
            .getSharedPreferences("auth", Context.MODE_PRIVATE)
            .edit()
            .putString("account_db", "account-v5-kept.db")
            .commit()

        val graph = AppGraph(context, http)

        assertNotNull(graph.accounts.account.value)
        assertEquals(
            setOf("account-v5-kept.db"),
            accountFiles().filter { it.endsWith(".db") }.toSet(),
        )
        assertEquals(listOf("account-v5-kept"), audio.list()?.toList())
        assertEquals(
            graph.cloudVoiceCache(graph.accounts.account.value!!),
            File(audio, "account-v5-kept"),
        )
    }

    private companion object {
        const val SERVER = "https://lionreader.example"
    }
}
