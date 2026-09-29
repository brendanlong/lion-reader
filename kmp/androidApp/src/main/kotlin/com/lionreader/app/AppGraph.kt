package com.lionreader.app

import android.content.Context
import androidx.core.content.edit
import app.cash.sqldelight.driver.android.AndroidSqliteDriver
import com.lionreader.shared.api.LionReaderApi
import com.lionreader.shared.auth.AppAuth
import com.lionreader.shared.auth.AuthorizationRequest
import com.lionreader.shared.auth.StoredTokens
import com.lionreader.shared.auth.TokenStore
import com.lionreader.shared.data.Reader
import com.lionreader.shared.db.LionReaderDatabase
import com.lionreader.shared.sync.RetentionPolicy
import com.lionreader.shared.sync.SyncEngine
import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.UserAgent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

const val DEFAULT_SERVER_URL = "https://lionreader.com"

/**
 * The app's singletons. Everything in one process shares them — the UI, the sync worker, and the
 * sign-in callback — which is what makes the token refresh single-flight (see AppAuth).
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

    val database =
        LionReaderDatabase(AndroidSqliteDriver(LionReaderDatabase.Schema, context, "lionreader.db"))

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    val currentSettings: StateFlow<AppSettings> =
        settings.settings.stateIn(scope, SharingStarted.Eagerly, AppSettings())

    private val _sessions = MutableStateFlow(newSession())

    /** Server-bound pieces; replaced when the (signed-out) user picks another server. */
    val sessions: StateFlow<ServerSession> = _sessions.asStateFlow()

    val session: ServerSession
        get() = _sessions.value

    private fun newSession() =
        ServerSession(serverUrl, http, PrefsTokenStore(prefs), database) {
            currentSettings.value.retention
        }

    val reader =
        Reader(database, System::currentTimeMillis, Dispatchers.IO) {
            SyncScheduler.flushSoon(context)
        }

    /**
     * Revokes and forgets the session, then clears the local store. Runs in the app's scope so
     * leaving the screen can't cancel the revocation.
     */
    fun signOut() {
        scope.launch {
            SyncScheduler.cancelAll(context)
            session.auth.signOut()
            session.sync.reset()
            SyncScheduler.schedulePeriodic(context)
        }
    }

    /** Only while signed out: the server is part of the sign-in identity. */
    fun setServerUrl(url: String) {
        prefs.edit(commit = true) { putString(SERVER_URL, url.trimEnd('/')) }
        _sessions.value = newSession()
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
        const val PENDING_STATE = "pending_state"
        const val PENDING_VERIFIER = "pending_verifier"
    }
}

class ServerSession(
    serverUrl: String,
    http: HttpClient,
    tokens: TokenStore,
    database: LionReaderDatabase,
    retention: () -> RetentionPolicy,
) {
    val auth = AppAuth(serverUrl, http, tokens, System::currentTimeMillis)
    val api = LionReaderApi(http, auth)
    val sync = SyncEngine(api, database, System::currentTimeMillis, retention)
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
