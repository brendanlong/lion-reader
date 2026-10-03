package com.lionreader.shared.account

import com.lionreader.shared.auth.AuthException
import com.lionreader.shared.auth.AuthorizationRequest
import com.lionreader.shared.data.currentTimeMillis
import com.lionreader.shared.sync.RetentionPolicy
import io.ktor.client.HttpClient
import io.ktor.http.Url
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
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
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.io.IOException
import okio.ByteString.Companion.encodeUtf8

const val DEFAULT_SERVER_URL = "https://lionreader.com"

/**
 * The app's accounts, one per process: everything in it shares them (the UI, background jobs, the
 * sign-in callback), which is what makes the token refresh single-flight (see AppAuth).
 *
 * Two layers: the [connection] to the chosen server (auth and API), and the signed-in [account] —
 * its own database file, reader and sync engine. Data of different accounts or servers never shares
 * a database, and signing out deletes the account's data.
 */
class Accounts(
    /** The sign-in state and the tokens. */
    private val store: KeyValueStore,
    private val storage: AccountStorage,
    private val background: BackgroundSync,
    private val http: HttpClient,
    /** The sign-in redirect's path, which the app claims (as an App Link, say). */
    private val callbackPath: String,
    /** Plain-http servers can be signed in to (debug builds, for dev servers). */
    private val allowHttp: Boolean,
    private val retention: () -> RetentionPolicy,
    /** For database work, which never runs on the main thread. */
    private val io: CoroutineDispatcher,
    /**
     * Before a session ends (a sign-out or a switch): stop what still uses it, such as narration of
     * its articles, whose cloud voices would go on with whoever's tokens are in now.
     */
    private val beforeSessionEnds: suspend () -> Unit = {},
    /** How soon to ask again which account a sign-in is, at first (it backs off). */
    private val confirmRetryMillis: Long = 5_000,
    private val now: () -> Long = ::currentTimeMillis,
) {
    val serverUrl: String
        get() = store.getString(SERVER_URL) ?: DEFAULT_SERVER_URL

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    private fun connect() =
        ServerConnection(serverUrl, http, KeyValueTokenStore(store), callbackPath, now)

    private val _connection = MutableStateFlow(connect())

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

    /**
     * Counts finished sign-ins, so each asks at once whose it is, whatever backoff the loop below
     * is in. The status alone can't wake it: a sign-out passes through Confirming (the account goes
     * before the tokens), and a sign-in right after can leave it there, to the eye of a collector,
     * with the sign-out's attempt backing off.
     */
    private val signIns = MutableStateFlow(0)

    init {
        // Until /auth/me says whose the tokens are, nothing shows or syncs, so
        // this keeps asking, on screen or not (e.g. a sign-in that finished offline).
        scope.launch {
            accountStatus.collectLatest { status ->
                if (status != AccountStatus.Confirming) return@collectLatest
                var wait = confirmRetryMillis
                while (true) {
                    val seen = signIns.value
                    try {
                        signedIn()
                    } catch (e: CancellationException) {
                        throw e
                    } catch (_: Exception) {}
                    val signedInAgain = withTimeoutOrNull(wait) { signIns.first { it != seen } }
                    wait =
                        if (signedInAgain != null) confirmRetryMillis
                        else (wait * 2).coerceAtMost(CONFIRM_RETRY_MAX_MILLIS)
                }
            }
        }
    }

    private fun restoreAccount(): AccountSession? {
        val dbName = store.getString(ACCOUNT_DB)
        storage.deleteAllBut(dbName)
        val confirmed =
            _connection.value.auth.signedIn.value && store.getBoolean(ACCOUNT_CONFIRMED, true)
        return dbName?.let { openAccount(it, confirmed) }
    }

    private fun openAccount(dbName: String, confirmed: Boolean) =
        AccountSession(
            dbName,
            _connection.value,
            confirmed,
            storage.openDatabase(dbName),
            retention,
            io,
            now,
            background::flushSoon,
        )

    /**
     * After a sign-in: asks the server who this is and switches to that account's database,
     * deleting the previous account's if it's another one.
     */
    private suspend fun signedIn() = accountMutex.withLock {
        val server = _connection.value
        val user = server.api.me()
        // Once it's begun, a switch is finished, its first sync included: confirming the
        // account cancels the loop that asked.
        withContext(NonCancellable) {
            // A new session's list syncs as it opens; the same account's, kept through an
            // involuntary sign-out, doesn't.
            if (switchTo(server, accountDbName(server.auth.serverUrl, user.id))) {
                background.syncNow()
            }
        }
    }

    /** Whether it opened a session (rather than finding this account's already open). */
    private suspend fun switchTo(server: ServerConnection, dbName: String): Boolean {
        val current = _account.value
        if (current?.dbName == dbName && current.connection === server) {
            store.edit { putBoolean(ACCOUNT_CONFIRMED, true) }
            current.confirm()
            return false
        }
        // Another account's data goes; the same account's is reopened on
        // the current connection, unsent changes and all.
        current?.let { endSession(it, deleteData = it.dbName != dbName) }
        store.edit {
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
                    withContext(io) { session.sync.flushOutbox() }
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
     * this object's scope, so leaving the screen can't cancel any of it.
     */
    fun signOut() {
        scope.launch {
            background.cancelAll()
            val auth = _connection.value.auth
            val forgotten = accountMutex.withLock {
                val session = _account.value
                _account.value = null
                pendingAuthorization = null
                // If the app dies before the data goes, the next start deletes it.
                store.edit { remove(ACCOUNT_DB) }
                session?.let { endSession(it, deleteData = true) }
                // The tokens go under the lock; revoking them needs the network, so it follows.
                // (Waiting for signedIn to read false instead could miss it: a sign-in right
                // after makes it true again, and the lock would never be released.)
                auth.forgetTokens()
            }
            background.schedulePeriodic()
            forgotten?.let { auth.revoke(it) }
        }
    }

    /**
     * Ends [session], for a sign-out or a switch: what uses it stops ([beforeSessionEnds]), the
     * account's requests are cancelled and its database is closed; with [deleteData], its data goes
     * too.
     */
    private suspend fun endSession(session: AccountSession, deleteData: Boolean) {
        // Before what uses it stops, so narration started meanwhile can't take its cloud voices.
        _account.compareAndSet(session, null)
        beforeSessionEnds()
        session.close()
        if (deleteData) storage.delete(session.dbName)
    }

    /** Only while signed out: the server is part of the sign-in identity. */
    private fun setServerUrl(url: String) {
        require(parseServerUrl(url, allowHttp) == ServerUrlInput.Valid(url))
        if (url == serverUrl) return
        store.edit { putString(SERVER_URL, url) }
        _connection.value = connect()
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
     * Finishes the sign-in from its [redirect]. In this object's scope, so the token exchange
     * outlives the screen (rotation, or the system destroying it behind the browser).
     */
    fun completeSignIn(redirect: String) {
        val pending = pendingAuthorization ?: return
        // Not this sign-in's redirect (a stale or forged link): leave it waiting for its own.
        val state = runCatching { Url(redirect).parameters["state"] }.getOrNull()
        if (state != pending.state) return
        pendingAuthorization = null
        val auth = _connection.value.auth
        // An account kept through an involuntary sign-out may not be the one
        // signing in: nothing shows or syncs it until /auth/me says it is (and
        // a restart before then remembers that).
        store.edit { putBoolean(ACCOUNT_CONFIRMED, false) }
        _account.value?.unconfirm()
        scope.launch {
            _signInError.value =
                try {
                    auth.completeAuthorization(redirect, pending)
                    signIns.update { it + 1 }
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

    /** The sign-in under way: what to open again in the browser, and how to check its redirect. */
    var pendingAuthorization: AuthorizationRequest?
        get() {
            val url = store.getString(PENDING_URL) ?: return null
            val state = store.getString(PENDING_STATE) ?: return null
            val verifier = store.getString(PENDING_VERIFIER) ?: return null
            return AuthorizationRequest(url, state, verifier)
        }
        private set(value) = store.edit {
            putString(PENDING_URL, value?.url)
            putString(PENDING_STATE, value?.state)
            putString(PENDING_VERIFIER, value?.codeVerifier)
        }

    private companion object {
        const val CONFIRM_RETRY_MAX_MILLIS = 60_000L
        const val FLUSH_BEFORE_SIGN_OUT_MS = 15_000L
        const val SERVER_URL = "server_url"
        const val ACCOUNT_DB = "account_db"
        const val ACCOUNT_CONFIRMED = "account_confirmed"
        const val PENDING_URL = "pending_url"
        const val PENDING_STATE = "pending_state"
        const val PENDING_VERIFIER = "pending_verifier"
    }
}

/** Part of every account's database name: changing it loses the data on the device. */
private const val ACCOUNT_DB_PREFIX = "account-v5-"

/** One database file per (server, account); the name doesn't reveal either. */
private fun accountDbName(serverUrl: String, userId: String): String =
    ACCOUNT_DB_PREFIX + "$serverUrl\n$userId".encodeUtf8().sha256().substring(0, 12).hex() + ".db"

/** Whether the app has an account to show: see [Accounts.accountStatus]. */
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
