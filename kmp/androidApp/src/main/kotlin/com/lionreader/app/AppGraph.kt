package com.lionreader.app

import android.content.Context
import androidx.core.content.edit
import androidx.core.net.toUri
import app.cash.sqldelight.driver.android.AndroidSqliteDriver
import com.lionreader.app.narration.CloudSpeechRequests
import com.lionreader.app.narration.CloudVoices
import com.lionreader.app.narration.DeviceVoices
import com.lionreader.app.narration.Narrator
import com.lionreader.app.narration.SpeechEngine
import com.lionreader.app.narration.SpeechInterrupted
import com.lionreader.app.narration.SpeechUnavailable
import com.lionreader.app.narration.SystemTts
import com.lionreader.app.ui.PageTurns
import com.lionreader.shared.api.ApiFailure
import com.lionreader.shared.api.LionReaderApi
import com.lionreader.shared.api.ResolvedVoice
import com.lionreader.shared.api.VoiceModels
import com.lionreader.shared.api.apiFailure
import com.lionreader.shared.auth.AppAuth
import com.lionreader.shared.auth.AuthException
import com.lionreader.shared.auth.AuthorizationRequest
import com.lionreader.shared.auth.StoredTokens
import com.lionreader.shared.auth.TokenStore
import com.lionreader.shared.data.AppSchema
import com.lionreader.shared.data.Reader
import com.lionreader.shared.db.LionReaderDatabase
import com.lionreader.shared.sync.RetentionPolicy
import com.lionreader.shared.sync.SyncEngine
import com.lionreader.shared.sync.followLiveUpdates
import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.UserAgent
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

const val DEFAULT_SERVER_URL = "https://lionreader.com"

/**
 * The app's singletons. Everything in one process shares them — the UI, the sync worker, and the
 * sign-in callback — which is what makes the token refresh single-flight (see AppAuth).
 *
 * Two layers: the [connection] to the chosen server (auth and API), and the signed-in [account] —
 * its own database file, reader and sync engine. Data of different accounts or servers never shares
 * a database, and signing out deletes the account's file.
 */
class AppGraph(
    private val context: Context,
    private val http: HttpClient = appHttpClient(),
    /** How soon to ask again which account a sign-in is, at first (it backs off). */
    private val confirmRetryMillis: Long = 5_000,
) {
    private val prefs = context.getSharedPreferences("auth", Context.MODE_PRIVATE)

    val settings = SettingsRepository(context, deviceDefaults())

    val serverUrl: String
        get() = prefs.getString(SERVER_URL, null) ?: DEFAULT_SERVER_URL

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    val currentSettings: StateFlow<AppSettings> =
        settings.settings.stateIn(scope, SharingStarted.Eagerly, settings.defaults)

    /** The device's text-to-speech engine (voices for Settings, and narration). */
    val systemTts: SystemTts by lazy { SystemTts(context) }

    private val narratorInstance = lazy {
        Narrator(context, currentSettings, ::speechEngine)
    }

    /** Text-to-speech narration; one article at a time, app-wide. */
    val narrator: Narrator by narratorInstance

    /** Whether narration is playing (without starting the narrator to ask). */
    val narrating: Boolean
        get() = narratorInstance.isInitialized() && narrator.state.value?.playing == true

    /** What the volume buttons turn the pages of, when the settings have them do so. */
    val pageTurns = PageTurns()

    /** Shared by every article's engine, so its limit on requests at once holds app-wide. */
    private val cloudSpeechRequests = CloudSpeechRequests()

    private suspend fun speechEngine(settings: AppSettings): SpeechEngine =
        when (settings.narrationEngine) {
            NarrationEngine.DEVICE -> DeviceVoices(systemTts, settings.narrationVoice)
            NarrationEngine.CLOUD -> {
                val session =
                    account.value ?: throw SpeechUnavailable("Sign in to use cloud voices.")
                val choice = cloudVoice(session, settings)
                CloudVoices(
                    session.connection.api,
                    choice.model.id,
                    choice.voice,
                    // The server takes up to 2 seconds.
                    settings.cloudVoicePauseSeconds.coerceIn(0f, 2f),
                    session.cloudVoiceCache,
                    session.work,
                    cloudSpeechRequests,
                )
            }
        }

    /** The cloud model and voice to use: the chosen ones if the server still offers them. */
    private suspend fun cloudVoice(session: AccountSession, settings: AppSettings): ResolvedVoice {
        val available =
            try {
                session.fetchVoiceModels(settings.cloudVoiceModel, settings.cloudVoice)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                when (val why = e.apiFailure()) {
                    ApiFailure.SignedOut -> throw SpeechUnavailable("Sign in to use cloud voices.")
                    is ApiFailure.Rejected ->
                        throw SpeechUnavailable(why.message ?: "Cloud voices aren't available.")
                    // Moving to the next article mustn't need the network just to find out again.
                    else ->
                        session.voiceModels.value
                            ?: throw SpeechInterrupted(
                                "Couldn't reach Lion Reader for cloud voices."
                            )
                }
            }
        return available.resolve(settings.cloudVoiceModel, settings.cloudVoice)
            ?: throw SpeechUnavailable("Cloud voices aren't set up for your account.")
    }

    /** Only the setting: the narrator follows it. */
    fun setNarrationSpeed(speed: Float) {
        scope.launch { settings.update { it.copy(narrationSpeed = speed) } }
    }

    private val _connection =
        MutableStateFlow(ServerConnection(serverUrl, http, PrefsTokenStore(prefs)))

    /** Replaced when the (signed-out) user picks another server. */
    val connection: StateFlow<ServerConnection> = _connection.asStateFlow()

    private val _account = MutableStateFlow(restoreAccount())

    /**
     * The account whose data is on the device. It outlives an involuntary sign-out (a dead refresh
     * token), so signing back in to the same account keeps its data and unsent changes.
     */
    val account: StateFlow<AccountSession?> = _account.asStateFlow()

    /** Serializes account switches. */
    private val accountMutex = Mutex()

    /** Whether there's an account to show, and which. */
    @OptIn(ExperimentalCoroutinesApi::class)
    val accountStatus: StateFlow<AccountStatus> =
        combine(
                _connection.flatMapLatest { server -> server.auth.signedIn.map { server to it } },
                _account.flatMapLatest { session ->
                    session?.confirmed?.map { yes -> session.takeIf { yes } } ?: flowOf(null)
                },
            ) { (server, signedIn), confirmed ->
                accountStatus(signedIn, server, confirmed)
            }
            .stateIn(
                scope,
                SharingStarted.Eagerly,
                accountStatus(
                    _connection.value.auth.signedIn.value,
                    _connection.value,
                    _account.value?.takeIf { it.confirmed.value },
                ),
            )

    init {
        // Until /auth/me says whose the tokens are, nothing shows or syncs, so
        // this keeps asking, on screen or not (e.g. a sign-in that finished offline).
        scope.launch {
            accountStatus.collectLatest { status ->
                if (status != AccountStatus.Confirming) return@collectLatest
                var wait = confirmRetryMillis
                while (true) {
                    try {
                        // A new session's list syncs as it opens; the same account's,
                        // kept through an involuntary sign-out, doesn't.
                        if (!signedIn()) syncInBackground()
                    } catch (e: CancellationException) {
                        throw e
                    } catch (_: Exception) {}
                    delay(wait)
                    wait = (wait * 2).coerceAtMost(CONFIRM_RETRY_MAX_MILLIS)
                }
            }
        }
    }

    private fun restoreAccount(): AccountSession? {
        val dbName = prefs.getString(ACCOUNT_DB, null)
        // Any other account's file and audio were left by a sign-out or switch
        // the app didn't live to finish.
        context
            .databaseList()
            .filter { it.startsWith("account-") && it.endsWith(".db") && it != dbName }
            .forEach { context.deleteDatabase(it) }
        val keep = dbName?.let { cloudVoiceCache(context, it) }
        cloudVoiceCaches(context)
            .listFiles()
            ?.filter { it != keep }
            ?.forEach { it.deleteRecursively() }
        val confirmed =
            _connection.value.auth.signedIn.value && prefs.getBoolean(ACCOUNT_CONFIRMED, true)
        return dbName?.let { openAccount(it, confirmed) }
    }

    private fun openAccount(dbName: String, confirmed: Boolean) =
        AccountSession(
            context,
            dbName,
            _connection.value,
            confirmed,
            { currentSettings.value.retention },
        ) {
            SyncScheduler.flushSoon(context)
        }

    /**
     * After a sign-in: asks the server who this is and switches to that account's database,
     * deleting the previous account's if it's another one. Whether it opened a session (rather than
     * finding this account's already open).
     */
    private suspend fun signedIn(): Boolean = accountMutex.withLock {
        val server = _connection.value
        val user = server.api.me()
        // Once it's begun, a switch is finished.
        withContext(NonCancellable) {
            switchTo(server, accountDbName(server.auth.serverUrl, user.id))
        }
    }

    private suspend fun switchTo(server: ServerConnection, dbName: String): Boolean {
        val current = _account.value
        if (current?.dbName == dbName && current.connection === server) {
            prefs.edit(commit = true) { putBoolean(ACCOUNT_CONFIRMED, true) }
            current.confirm()
            return false
        }
        // Another account's data goes; the same account's is reopened on
        // the current connection, unsent changes and all.
        current?.let { endSession(it, deleteData = it.dbName != dbName) }
        prefs.edit(commit = true) {
            putString(ACCOUNT_DB, dbName)
            putBoolean(ACCOUNT_CONFIRMED, true)
        }
        _account.value = openAccount(dbName, confirmed = true)
        return true
    }

    /**
     * Before signing out: sends the unsent changes if it can, and says how many are left (which
     * signing out loses).
     */
    suspend fun unsentChangesAfterFlush(): Long {
        val session = _account.value ?: return 0
        return try {
            if (session.unsentChanges() == 0L) return 0
            withTimeoutOrNull(FLUSH_BEFORE_SIGN_OUT_MS) {
                try {
                    withContext(Dispatchers.IO) { session.sync.flushOutbox() }
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {}
            }
            session.unsentChanges()
        } catch (e: SessionClosed) {
            throw e
        } catch (_: Exception) {
            // A database it can't read holds nothing it could send.
            0
        }
    }

    /**
     * Deletes the account's data, then the tokens, under the account lock, so a sign-in can't start
     * in between and see its new database deleted; revoking the session follows, best effort. In
     * the app's scope, so leaving the screen can't cancel any of it.
     */
    fun signOut() {
        scope.launch {
            SyncScheduler.cancelAll(context)
            val auth = _connection.value.auth
            accountMutex.withLock {
                val session = _account.value
                _account.value = null
                pendingAuthorization = null
                // If the app dies before the data goes, the next start deletes it.
                prefs.edit(commit = true) { remove(ACCOUNT_DB) }
                session?.let { endSession(it, deleteData = true) }
                // AppAuth.signOut forgets the tokens before it reaches the network.
                launch(start = CoroutineStart.UNDISPATCHED) { auth.signOut() }
                auth.signedIn.first { !it }
            }
            SyncScheduler.schedulePeriodic(context)
        }
    }

    /**
     * Ends [session], for a sign-out or a switch: narration stops (it may be reading the account's
     * articles, with cloud voices on whoever's tokens are in now), the account's requests are
     * cancelled and its database is closed; with [deleteData], its database and audio go too.
     */
    private suspend fun endSession(session: AccountSession, deleteData: Boolean) {
        if (narratorInstance.isInitialized()) withContext(Dispatchers.Main) { narrator.stop() }
        session.close()
        if (deleteData) {
            context.deleteDatabase(session.dbName)
            session.cloudVoiceCache.deleteRecursively()
        }
    }

    /** A full sync (article bodies included) in a background job. */
    fun syncInBackground() = SyncScheduler.syncNow(context)

    /** Only while signed out: the server is part of the sign-in identity. */
    private fun setServerUrl(url: String) {
        require(parseServerUrl(url, BuildConfig.DEBUG) == ServerUrlInput.Valid(url))
        if (url == serverUrl) return
        prefs.edit(commit = true) { putString(SERVER_URL, url) }
        _connection.value = ServerConnection(serverUrl, http, PrefsTokenStore(prefs))
    }

    private val _signInError = MutableStateFlow<String?>(null)

    /** Why the last sign-in failed, until another starts. */
    val signInError: StateFlow<String?> = _signInError.asStateFlow()

    /**
     * A sign-in on [serverUrl] (from [parseServerUrl]): the authorization request to open in the
     * browser, kept until its redirect comes back.
     */
    suspend fun startSignIn(serverUrl: String): AuthorizationRequest {
        setServerUrl(serverUrl)
        _signInError.value = null
        return _connection.value.auth.authorizationRequest().also { pendingAuthorization = it }
    }

    /**
     * Finishes the sign-in from its [redirect]. In the app's scope, so the token exchange outlives
     * the Activity (rotation, or the system destroying it behind the browser).
     */
    fun completeSignIn(redirect: String) {
        val pending = pendingAuthorization ?: return
        // Not this sign-in's redirect (a stale or forged link): leave it waiting for its own.
        if (redirect.toUri().getQueryParameter("state") != pending.state) return
        pendingAuthorization = null
        val auth = _connection.value.auth
        // An account kept through an involuntary sign-out may not be the one
        // signing in: nothing shows or syncs it until /auth/me says it is (and
        // a restart before then remembers that).
        prefs.edit(commit = true) { putBoolean(ACCOUNT_CONFIRMED, false) }
        _account.value?.unconfirm()
        scope.launch {
            _signInError.value =
                try {
                    auth.completeAuthorization(redirect, pending)
                    null
                } catch (e: CancellationException) {
                    throw e
                } catch (e: AuthException) {
                    e.message
                } catch (_: IOException) {
                    "Couldn't reach the server"
                } catch (_: Exception) {
                    "Sign-in failed"
                }
            // Signed in, accountStatus is Confirming, which asks which account this is.
        }
    }

    /** The sign-in under way: what to open again in a Custom Tab, and how to check its redirect. */
    var pendingAuthorization: AuthorizationRequest?
        get() {
            val url = prefs.getString(PENDING_URL, null) ?: return null
            val state = prefs.getString(PENDING_STATE, null) ?: return null
            val verifier = prefs.getString(PENDING_VERIFIER, null) ?: return null
            return AuthorizationRequest(url, state, verifier)
        }
        private set(value) =
            prefs.edit(commit = true) {
                putString(PENDING_URL, value?.url)
                putString(PENDING_STATE, value?.state)
                putString(PENDING_VERIFIER, value?.codeVerifier)
            }

    private companion object {
        const val CONFIRM_RETRY_MAX_MILLIS = 60_000L
        const val SERVER_URL = "server_url"
        const val ACCOUNT_DB = "account_db"
        const val ACCOUNT_CONFIRMED = "account_confirmed"
        const val PENDING_URL = "pending_url"
        const val PENDING_STATE = "pending_state"
        const val PENDING_VERIFIER = "pending_verifier"
    }
}

private const val FLUSH_BEFORE_SIGN_OUT_MS = 15_000L

/** Part of every account's database name: changing it loses the data on the device. */
private const val DB_PREFIX = "account-v5-"

/** One database file per (server, account); the name doesn't reveal either. */
private fun accountDbName(serverUrl: String, userId: String): String {
    val digest = MessageDigest.getInstance("SHA-256").digest("$serverUrl\n$userId".toByteArray())
    return DB_PREFIX + digest.take(12).joinToString("") { "%02x".format(it) } + ".db"
}

private fun appHttpClient() =
    HttpClient(OkHttp) {
        install(UserAgent) { agent = "LionReader-Android/${BuildConfig.VERSION_NAME}" }
        install(HttpTimeout) {
            connectTimeoutMillis = 15_000
            requestTimeoutMillis = 60_000
        }
    }

class ServerConnection(serverUrl: String, http: HttpClient, tokens: TokenStore) {
    val auth =
        AppAuth(
            serverUrl,
            http,
            tokens,
            BuildConfig.SIGN_IN_CALLBACK_PATH,
            System::currentTimeMillis,
        )
    val api = LionReaderApi(http, auth)
}

/** Whether the app has an account to show: see [AppGraph.accountStatus]. */
sealed interface AccountStatus {
    data object SignedOut : AccountStatus

    /** Signed in, but whose tokens they are isn't settled yet (e.g. /auth/me failed offline). */
    data object Confirming : AccountStatus

    data class Ready(val session: AccountSession) : AccountStatus
}

/** [confirmed]: the account on the device, if its tokens are known to be its. */
private fun accountStatus(
    signedIn: Boolean,
    server: ServerConnection,
    confirmed: AccountSession?,
): AccountStatus =
    when {
        !signedIn -> AccountStatus.SignedOut
        confirmed == null || confirmed.connection !== server -> AccountStatus.Confirming
        else -> AccountStatus.Ready(confirmed)
    }

/** A signed-in account's local data and the sync that maintains it. */
class AccountSession(
    context: Context,
    val dbName: String,
    val connection: ServerConnection,
    confirmed: Boolean,
    retention: () -> RetentionPolicy,
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

    private val driver = SessionDriver(AndroidSqliteDriver(AppSchema, context, dbName))
    private val database = LionReaderDatabase(driver)
    val reader = Reader(database, System::currentTimeMillis, Dispatchers.IO, onLocalChange)
    val sync = SyncEngine(connection.api, database, System::currentTimeMillis, retention)

    private var summariesAvailable = false

    /**
     * Whether the server can summarize for this account, or null when it can't be asked (offline).
     * A yes is remembered; a no is asked again, since the user can add an AI key on the web.
     */
    suspend fun summariesAvailable(): Boolean? {
        if (summariesAvailable) return true
        return try {
            withContext(Dispatchers.IO) { sync.summariesAvailable() }
                .also { summariesAvailable = it }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            null
        }
    }

    /** Pulls whenever the server says something changed, until cancelled (see kmp/CLAUDE.md). */
    suspend fun followServer() =
        withContext(Dispatchers.IO) { followLiveUpdates(connection.api, pull = { sync.sync() }) }

    /** The user's changes not yet on the server. */
    suspend fun unsentChanges(): Long =
        withContext(Dispatchers.IO) { database.outboxQueries.countStates().executeAsOne() }

    /** Cloud narration audio of the account's articles, so it goes with the account. */
    val cloudVoiceCache = cloudVoiceCache(context, dbName)

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

    fun close() {
        work.cancel()
        driver.close()
    }
}

/** Every account's [AccountSession.cloudVoiceCache]. */
private fun cloudVoiceCaches(context: Context) = File(context.cacheDir, "cloud-voices")

private fun cloudVoiceCache(context: Context, dbName: String) =
    File(cloudVoiceCaches(context), dbName.removeSuffix(".db"))

/**
 * Tokens in app-private SharedPreferences, written with `commit` so a rotated refresh token is on
 * disk before it is used (the old one is dead by then).
 */
private class PrefsTokenStore(private val prefs: android.content.SharedPreferences) : TokenStore {
    override fun load(): StoredTokens? {
        val access = prefs.getString("access_token", null) ?: return null
        val refresh = prefs.getString("refresh_token", null) ?: return null
        return StoredTokens(access, refresh, prefs.getLong("access_expires_at", 0))
    }

    override fun save(tokens: StoredTokens?) {
        prefs.edit(commit = true) {
            putString("access_token", tokens?.accessToken)
            putString("refresh_token", tokens?.refreshToken)
            putLong("access_expires_at", tokens?.accessTokenExpiresAtMillis ?: 0)
        }
    }
}
