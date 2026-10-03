package com.lionreader.shared.auth

import com.lionreader.shared.api.ApiJson
import com.lionreader.shared.api.TokenResponse
import io.ktor.client.HttpClient
import io.ktor.client.request.forms.submitForm
import io.ktor.client.statement.bodyAsText
import io.ktor.http.URLBuilder
import io.ktor.http.isSuccess
import io.ktor.http.parameters
import io.ktor.util.Digest
import kotlin.io.encoding.Base64
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

const val APP_CLIENT_ID = "lion-reader-app"
private const val SCOPE = "reader:full-access"

/** Refresh this long before the access token actually expires. */
private const val EXPIRY_MARGIN_MS = 60_000L

data class StoredTokens(
    val accessToken: String,
    val refreshToken: String,
    val accessTokenExpiresAtMillis: Long,
)

/** Persists tokens. `save` must be durable when it returns (see [AppAuth.accessToken]). */
interface TokenStore {
    fun load(): StoredTokens?

    fun save(tokens: StoredTokens?)
}

/** An in-flight sign-in; keep it until the redirect comes back. */
data class AuthorizationRequest(val url: String, val state: String, val codeVerifier: String)

class AuthException(message: String) : Exception(message)

/**
 * OAuth 2.1 authorization-code + PKCE sign-in against the server's first-party app client, and
 * access-token refresh.
 *
 * Refresh tokens rotate and the server revokes the whole token family when a rotated token is
 * presented twice, so refreshing is serialized through one mutex (every caller in the process
 * shares this instance) and the new pair is persisted before it is used.
 */
class AppAuth(
    val serverUrl: String,
    private val http: HttpClient,
    private val store: TokenStore,
    /** Each build of the app has its own, so only it receives its redirects. */
    callbackPath: String = "/oauth/app-callback",
    private val now: () -> Long,
) {
    val redirectUri: String = "$serverUrl$callbackPath"

    private val mutex = Mutex()
    private val _signedIn = MutableStateFlow(store.load() != null)
    val signedIn: StateFlow<Boolean> = _signedIn.asStateFlow()

    suspend fun authorizationRequest(): AuthorizationRequest {
        val verifier = base64Url(secureRandomBytes(32))
        val state = base64Url(secureRandomBytes(16))
        val url =
            URLBuilder("$serverUrl/oauth/authorize")
                .apply {
                    parameters.append("response_type", "code")
                    parameters.append("client_id", APP_CLIENT_ID)
                    parameters.append("redirect_uri", redirectUri)
                    parameters.append("scope", SCOPE)
                    parameters.append("state", state)
                    parameters.append("code_challenge", codeChallenge(verifier))
                    parameters.append("code_challenge_method", "S256")
                }
                .buildString()
        return AuthorizationRequest(url, state, verifier)
    }

    /** Finishes sign-in from the redirect URL the app was opened with. */
    suspend fun completeAuthorization(redirect: String, request: AuthorizationRequest) {
        val params = io.ktor.http.Url(redirect).parameters
        params["error"]?.let { throw AuthException(params["error_description"] ?: it) }
        if (params["state"] != request.state) throw AuthException("Sign-in response didn't match")
        val code = params["code"] ?: throw AuthException("Sign-in response had no code")
        val tokens =
            tokenRequest(
                "grant_type" to "authorization_code",
                "code" to code,
                "redirect_uri" to redirectUri,
                "code_verifier" to request.codeVerifier,
            ) ?: throw AuthException("The server rejected the sign-in")
        mutex.withLock { persist(tokens) }
    }

    /**
     * A usable access token, refreshing first if it is (nearly) expired or [forceRefresh] is set,
     * or null when signed out. A rejected refresh token signs the user out; a network failure
     * throws and leaves the tokens alone.
     */
    suspend fun accessToken(forceRefresh: Boolean = false, rejected: String? = null): String? =
        mutex.withLock {
            val current = store.load() ?: return@withLock null
            // Another caller refreshed while this one waited for the lock.
            val stale = forceRefresh && current.accessToken == rejected
            if (!stale && current.accessTokenExpiresAtMillis - EXPIRY_MARGIN_MS > now()) {
                return@withLock current.accessToken
            }
            val refreshed =
                tokenRequest(
                    "grant_type" to "refresh_token",
                    "refresh_token" to current.refreshToken,
                )
            if (refreshed == null) {
                persist(null)
                null
            } else {
                persist(refreshed)
                refreshed.accessToken
            }
        }

    /**
     * Signs out on the device: forgets the tokens, returning them so their session can be
     * [revoke]d.
     */
    suspend fun forgetTokens(): StoredTokens? = mutex.withLock {
        store.load().also { persist(null) }
    }

    /** Ends [tokens]' session on the server, best effort. */
    suspend fun revoke(tokens: StoredTokens) {
        runCatching {
            http.submitForm(
                "$serverUrl/oauth/revoke",
                parameters {
                    append("token", tokens.refreshToken)
                    append("client_id", APP_CLIENT_ID)
                },
            )
        }
    }

    private fun persist(tokens: StoredTokens?) {
        store.save(tokens)
        _signedIn.value = tokens != null
    }

    /** Null when the server rejected the grant; throws on transport failure. */
    private suspend fun tokenRequest(vararg fields: Pair<String, String>): StoredTokens? {
        val response =
            http.submitForm(
                "$serverUrl/oauth/token",
                parameters {
                    fields.forEach { (key, value) -> append(key, value) }
                    append("client_id", APP_CLIENT_ID)
                },
            )
        // invalid_grant / invalid_client: the grant is dead. Anything else
        // (429, 5xx) is transient and must not sign the user out.
        if (response.status.value == 400 || response.status.value == 401) return null
        if (!response.status.isSuccess()) {
            throw AuthException("Token endpoint returned ${response.status.value}")
        }
        val body = ApiJson.decodeFromString(TokenResponse.serializer(), response.bodyAsText())
        return StoredTokens(body.accessToken, body.refreshToken, now() + body.expiresIn * 1000)
    }
}

private fun base64Url(bytes: ByteArray): String =
    Base64.UrlSafe.withPadding(Base64.PaddingOption.ABSENT).encode(bytes)

internal suspend fun codeChallenge(verifier: String): String {
    val digest = Digest("SHA-256")
    digest += verifier.encodeToByteArray()
    return base64Url(digest.build())
}
