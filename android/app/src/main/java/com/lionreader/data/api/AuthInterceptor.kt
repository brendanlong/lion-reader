package com.lionreader.data.api

import io.ktor.client.plugins.api.createClientPlugin
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.request.header
import io.ktor.http.HttpHeaders
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Interceptor that adds authentication headers to HTTP requests.
 *
 * This interceptor retrieves the session token from SessionStore and adds it
 * as a Bearer token in the Authorization header. If no token is available,
 * the request proceeds without authentication headers.
 */
@Singleton
class AuthInterceptor @Inject constructor(
    private val sessionStore: SessionStore,
) {
    /**
     * Adds the authentication header to the request if a token is available.
     *
     * @param request The HTTP request builder to modify
     */
    fun intercept(request: HttpRequestBuilder) {
        sessionStore.getToken()?.let { token ->
            request.header(HttpHeaders.Authorization, "Bearer $token")
        }
    }

    /**
     * Checks if authentication is currently available.
     *
     * @return true if a session token exists
     */
    fun hasAuth(): Boolean = sessionStore.hasSession()
}

/**
 * Ktor plugin that automatically adds authentication headers to requests.
 *
 * Usage:
 * ```kotlin
 * HttpClient {
 *     install(AuthPlugin) {
 *         authInterceptor = myAuthInterceptor
 *     }
 * }
 * ```
 */
val AuthPlugin = createClientPlugin("AuthPlugin", ::AuthPluginConfig) {
    val authInterceptor = pluginConfig.authInterceptor
        ?: throw IllegalStateException("AuthInterceptor must be provided")

    onRequest { request, _ ->
        authInterceptor.intercept(request)
    }
}

/**
 * Configuration for the AuthPlugin.
 */
class AuthPluginConfig {
    /**
     * The AuthInterceptor instance to use for adding authentication headers.
     */
    var authInterceptor: AuthInterceptor? = null
}
