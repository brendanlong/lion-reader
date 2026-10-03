package com.lionreader.shared.account

import app.cash.sqldelight.db.SqlDriver
import com.lionreader.shared.api.ApiFailure
import com.lionreader.shared.api.LionReaderApi
import com.lionreader.shared.api.ResolvedVoice
import com.lionreader.shared.api.VoiceModels
import com.lionreader.shared.api.apiFailure
import com.lionreader.shared.auth.AppAuth
import com.lionreader.shared.auth.TokenStore
import com.lionreader.shared.data.Reader
import com.lionreader.shared.db.LionReaderDatabase
import com.lionreader.shared.narration.SpeechInterrupted
import com.lionreader.shared.narration.SpeechUnavailable
import com.lionreader.shared.sync.RetentionPolicy
import com.lionreader.shared.sync.SyncEngine
import com.lionreader.shared.sync.followLiveUpdates
import io.ktor.client.HttpClient
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext

/** The chosen server: signing in to it, and its API as the signed-in user. */
class ServerConnection(
    serverUrl: String,
    http: HttpClient,
    tokens: TokenStore,
    callbackPath: String,
    now: () -> Long,
) {
    val auth = AppAuth(serverUrl, http, tokens, callbackPath, now)
    val api = LionReaderApi(http, auth)
}

/** A signed-in account's local data and the sync that maintains it. */
class AccountSession
internal constructor(
    val dbName: String,
    val connection: ServerConnection,
    confirmed: Boolean,
    driver: SqlDriver,
    retention: () -> RetentionPolicy,
    private val io: CoroutineDispatcher,
    now: () -> Long,
    onLocalChange: () -> Unit,
) {
    private val _confirmed = MutableStateFlow(confirmed)

    /**
     * Whether the signed-in tokens are this account's. Not while a sign-in after an involuntary
     * sign-out hasn't yet asked /auth/me whose they are: until then, showing or syncing this
     * account could send its changes as someone else.
     */
    val confirmed: StateFlow<Boolean> = _confirmed.asStateFlow()

    internal fun confirm() {
        _confirmed.value = true
    }

    internal fun unconfirm() {
        _confirmed.value = false
    }

    private val driver = SessionDriver(driver)
    private val database = LionReaderDatabase(this.driver)
    val reader = Reader(database, now, io, onLocalChange)

    /** Doesn't switch threads, so call it on [io] (as [runBackgroundSync] does). */
    val sync = SyncEngine(connection.api, database, now, retention)

    /** The lists, not the article bodies: what pulling to refresh waits for. */
    suspend fun syncLists() = withContext(io) { sync.sync(downloadContent = false) }

    private var summariesAvailable = false

    /**
     * Whether the server can summarize for this account, or null when it can't be asked (offline).
     * A yes is remembered; a no is asked again, since the user can add an AI key on the web.
     */
    suspend fun summariesAvailable(): Boolean? {
        if (summariesAvailable) return true
        return try {
            withContext(io) { sync.summariesAvailable() }.also { summariesAvailable = it }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            null
        }
    }

    /** Summarizes [entryId] into its article on the device. */
    suspend fun summarize(entryId: String) = withContext(io) { sync.summarize(entryId) }

    /**
     * Pulls whenever the server says something changed, until cancelled ([followLiveUpdates]). The
     * app runs it only while on screen; in the background the periodic sync is all there is.
     */
    suspend fun followServer() =
        withContext(io) { followLiveUpdates(connection.api, pull = { sync.sync() }) }

    /** The user's changes not yet on the server. */
    suspend fun unsentChanges(): Long =
        withContext(io) { database.outboxQueries.countStates().executeAsOne() }

    /** The account's work that outlives the screen that asked for it (cloud speech), not it. */
    val work = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    private val _voiceModels = MutableStateFlow<VoiceModels?>(null)

    /** The cloud voices the server last offered this account; null until it's been asked. */
    val voiceModels: StateFlow<VoiceModels?> = _voiceModels.asStateFlow()

    /**
     * Asks the server for its cloud voices, into [voiceModels]. It lists [model]'s [voice] while
     * the provider has it, even once it no longer offers it, so a chosen voice stays chosen.
     */
    suspend fun fetchVoiceModels(model: String?, voice: String?): VoiceModels =
        connection.api.voiceModels(model, voice).also { _voiceModels.value = it }

    /**
     * The cloud model and voice to narrate with: the chosen [model] and [voice] if the server still
     * offers them, else its defaults. Throws the [com.lionreader.shared.narration.SpeechException]
     * saying why there's none.
     */
    suspend fun cloudVoice(model: String?, voice: String?): ResolvedVoice {
        val available =
            try {
                fetchVoiceModels(model, voice)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                when (val why = e.apiFailure()) {
                    ApiFailure.SignedOut -> throw SpeechUnavailable("Sign in to use cloud voices.")
                    is ApiFailure.Rejected ->
                        throw SpeechUnavailable(why.message ?: "Cloud voices aren't available.")
                    // Moving to the next article mustn't need the network just to find out again.
                    else ->
                        voiceModels.value
                            ?: throw SpeechInterrupted(
                                "Couldn't reach Lion Reader for cloud voices."
                            )
                }
            }
        return available.resolve(model, voice)
            ?: throw SpeechUnavailable("Cloud voices aren't set up for your account.")
    }

    fun close() {
        work.cancel()
        driver.close()
    }
}
