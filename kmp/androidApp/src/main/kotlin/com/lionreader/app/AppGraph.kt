package com.lionreader.app

import android.content.Context
import androidx.core.content.edit
import app.cash.sqldelight.driver.android.AndroidSqliteDriver
import com.lionreader.app.narration.CloudVoices
import com.lionreader.app.narration.DeviceVoices
import com.lionreader.app.narration.Narrator
import com.lionreader.app.narration.SpeechEngine
import com.lionreader.app.narration.SpeechInterrupted
import com.lionreader.app.narration.SpeechUnavailable
import com.lionreader.app.narration.SystemTts
import com.lionreader.shared.api.ApiException
import com.lionreader.shared.api.LionReaderApi
import com.lionreader.shared.api.VoiceModels
import com.lionreader.shared.auth.AppAuth
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
import java.security.MessageDigest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

const val DEFAULT_SERVER_URL = "https://lionreader.com"

/**
 * The app's singletons. Everything in one process shares them — the UI, the sync worker, and the
 * sign-in callback — which is what makes the token refresh single-flight (see AppAuth).
 *
 * Two layers: the [connection] to the chosen server (auth and API), and the signed-in [account] —
 * its own database file, reader and sync engine. Data of different accounts or servers never shares
 * a database, and signing out deletes the account's file.
 */
class AppGraph(private val context: Context) {
    private val prefs = context.getSharedPreferences("auth", Context.MODE_PRIVATE)

    val settings = SettingsRepository(context)

    val serverUrl: String
        get() = prefs.getString(SERVER_URL, null) ?: DEFAULT_SERVER_URL

    private val http =
        HttpClient(OkHttp) {
            install(UserAgent) { agent = "LionReader-Android/${BuildConfig.VERSION_NAME}" }
            install(HttpTimeout) {
                connectTimeoutMillis = 15_000
                requestTimeoutMillis = 60_000
            }
        }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    val currentSettings: StateFlow<AppSettings> =
        settings.settings.stateIn(scope, SharingStarted.Eagerly, AppSettings())

    /** The device's text-to-speech engine (voices for Settings, and narration). */
    val systemTts: SystemTts by lazy { SystemTts(context) }

    private val narratorInstance = lazy {
        Narrator(context, { currentSettings.value }, ::speechEngine)
    }

    /** Text-to-speech narration; one article at a time, app-wide. */
    val narrator: Narrator by narratorInstance

    /** Cloud narration audio: the account's articles, so it goes with the account. */
    private val cloudVoiceCache = File(context.cacheDir, "cloud-voices")

    private suspend fun speechEngine(settings: AppSettings): SpeechEngine =
        when (settings.narrationEngine) {
            NarrationEngine.DEVICE -> DeviceVoices(systemTts, settings.narrationVoice)
            NarrationEngine.CLOUD -> {
                val api =
                    account.value?.connection?.api
                        ?: throw SpeechUnavailable("Sign in to use cloud voices.")
                val choice = cloudVoice(api, settings)
                CloudVoices(api, choice.first, choice.second, cloudVoiceCache, scope)
            }
        }

    /**
     * The voices the server last offered, for the account by that database: narration moving to the
     * next article mustn't need the network just to find out again.
     */
    @Volatile private var lastVoiceModels: Pair<String?, VoiceModels>? = null

    /** The cloud model and voice to use: the chosen ones if the server still offers them. */
    private suspend fun cloudVoice(
        api: LionReaderApi,
        settings: AppSettings,
    ): Pair<String, String> {
        val accountDb = account.value?.dbName
        val available =
            try {
                api.voiceModels().also { lastVoiceModels = accountDb to it }
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException) {
                if (e.status == 0) throw SpeechUnavailable("Sign in to use cloud voices.")
                if (e.isPermanent || (e.status in 400..499 && e.status != 429)) {
                    throw SpeechUnavailable(e.serverMessage ?: "Cloud voices aren't available.")
                }
                lastVoiceModels?.takeIf { it.first == accountDb }?.second
                    ?: throw SpeechInterrupted("Couldn't reach Lion Reader for cloud voices.")
            } catch (_: Exception) {
                lastVoiceModels?.takeIf { it.first == accountDb }?.second
                    ?: throw SpeechInterrupted("Couldn't reach Lion Reader for cloud voices.")
            }
        val model =
            available.models.firstOrNull { it.id == settings.cloudVoiceModel }
                ?: available.models.firstOrNull { it.id == available.defaultModelId }
                ?: available.models.firstOrNull()
                ?: throw SpeechUnavailable("Cloud voices aren't set up for your account.")
        val voice = settings.cloudVoice?.takeIf { it in model.voices } ?: model.defaultVoice
        return model.id to voice
    }

    fun setNarrationSpeed(speed: Float) {
        scope.launch { settings.update { it.copy(narrationSpeed = speed) } }
        if (narratorInstance.isInitialized()) narrator.setSpeed(speed)
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

    private fun restoreAccount(): AccountSession? {
        // Delete files from older schema generations (see DB_PREFIX); a
        // signed-in account is set up again after the next /auth/me.
        context
            .databaseList()
            .filter {
                it.endsWith(".db") &&
                    ((it.startsWith("account-") && !it.startsWith(DB_PREFIX)) ||
                        it == "lionreader.db")
            }
            .forEach { context.deleteDatabase(it) }
        val dbName =
            prefs.getString(ACCOUNT_DB, null)?.takeIf { it.startsWith(DB_PREFIX) } ?: return null
        return openAccount(dbName)
    }

    private fun openAccount(dbName: String) =
        AccountSession(context, dbName, _connection.value, { currentSettings.value.retention }) {
            SyncScheduler.flushSoon(context)
        }

    /**
     * After a sign-in: asks the server who this is and switches to that account's database,
     * deleting the previous account's if it's another one.
     */
    suspend fun signedIn() = accountMutex.withLock {
        val server = _connection.value
        val user = server.api.me()
        val dbName = accountDbName(server.auth.serverUrl, user.id)
        val current = _account.value
        if (current?.dbName == dbName && current.connection === server) return@withLock
        current?.close()
        // Another account's data goes; the same account's is reopened on
        // the current connection, unsent changes and all.
        if (current != null && current.dbName != dbName) {
            context.deleteDatabase(current.dbName)
            cloudVoiceCache.deleteRecursively()
        }
        prefs.edit(commit = true) { putString(ACCOUNT_DB, dbName) }
        _account.value = openAccount(dbName)
    }

    /**
     * Revokes the session and deletes the account's data. Runs in the app's scope so leaving the
     * screen can't cancel the revocation.
     */
    fun signOut() {
        if (narratorInstance.isInitialized()) narrator.stop()
        scope.launch {
            SyncScheduler.cancelAll(context)
            _connection.value.auth.signOut()
            accountMutex.withLock {
                _account.value?.let {
                    it.close()
                    context.deleteDatabase(it.dbName)
                }
                cloudVoiceCache.deleteRecursively()
                _account.value = null
                prefs.edit(commit = true) { remove(ACCOUNT_DB) }
            }
            SyncScheduler.schedulePeriodic(context)
        }
    }

    /** A full sync (article bodies included) in a background job. */
    fun syncInBackground() = SyncScheduler.syncNow(context)

    /** Only while signed out: the server is part of the sign-in identity. */
    fun setServerUrl(url: String) {
        if (url.trimEnd('/') == serverUrl) return
        prefs.edit(commit = true) { putString(SERVER_URL, url.trimEnd('/')) }
        _connection.value = ServerConnection(serverUrl, http, PrefsTokenStore(prefs))
    }

    var pendingAuthorization: AuthorizationRequest?
        get() =
            prefs.getString(PENDING_STATE, null)?.let { state ->
                AuthorizationRequest(
                    url = "",
                    state = state,
                    codeVerifier = prefs.getString(PENDING_VERIFIER, null) ?: return null,
                )
            }
        set(value) =
            prefs.edit(commit = true) {
                putString(PENDING_STATE, value?.state)
                putString(PENDING_VERIFIER, value?.codeVerifier)
            }

    private companion object {
        const val SERVER_URL = "server_url"
        const val ACCOUNT_DB = "account_db"
        const val PENDING_STATE = "pending_state"
        const val PENDING_VERIFIER = "pending_verifier"
    }
}

/** Database file schema generation; bump it on a pre-release schema change (kmp/CLAUDE.md). */
private const val DB_PREFIX = "account-v5-"

/** One database file per (server, account); the name doesn't reveal either. */
private fun accountDbName(serverUrl: String, userId: String): String {
    val digest = MessageDigest.getInstance("SHA-256").digest("$serverUrl\n$userId".toByteArray())
    return DB_PREFIX + digest.take(12).joinToString("") { "%02x".format(it) } + ".db"
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

/** A signed-in account's local data and the sync that maintains it. */
class AccountSession(
    context: Context,
    val dbName: String,
    val connection: ServerConnection,
    retention: () -> RetentionPolicy,
    onLocalChange: () -> Unit,
) {
    private val driver = AndroidSqliteDriver(AppSchema, context, dbName)
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

    fun close() = driver.close()
}

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
