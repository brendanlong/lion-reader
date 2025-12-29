package com.lionreader.data.repository

import com.lionreader.data.api.ApiResult
import com.lionreader.data.api.LionReaderApi
import com.lionreader.data.api.SessionStore
import com.lionreader.data.api.models.User
import kotlinx.coroutines.flow.StateFlow
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Result of an authentication operation.
 */
sealed class AuthResult {
    data class Success(
        val user: User,
    ) : AuthResult()

    data class Error(
        val code: String,
        val message: String,
    ) : AuthResult()

    data object NetworkError : AuthResult()
}

/**
 * Repository for authentication operations.
 *
 * Handles login, logout, and session management. Delegates API calls to
 * LionReaderApi and persists session information via SessionStore.
 */
@Singleton
class AuthRepository
    @Inject
    constructor(
        private val api: LionReaderApi,
        private val sessionStore: SessionStore,
    ) {
        /**
         * Observable state indicating whether the user is logged in.
         *
         * Emits true when a valid session exists, false otherwise.
         */
        val isLoggedIn: StateFlow<Boolean> = sessionStore.isLoggedIn

        /**
         * Attempts to log in with email and password credentials.
         *
         * On success, stores the session token and user information.
         *
         * @param email User's email address
         * @param password User's password
         * @return AuthResult indicating success or the type of failure
         */
        suspend fun login(
            email: String,
            password: String,
        ): AuthResult =
            when (val result = api.login(email, password)) {
                is ApiResult.Success -> {
                    val response = result.data
                    sessionStore.saveSession(
                        token = response.sessionToken,
                        userId = response.user.id,
                        email = response.user.email,
                    )
                    AuthResult.Success(response.user)
                }
                is ApiResult.Error -> {
                    AuthResult.Error(result.code, result.message)
                }
                is ApiResult.NetworkError -> {
                    AuthResult.NetworkError
                }
                is ApiResult.Unauthorized -> {
                    AuthResult.Error("UNAUTHORIZED", "Invalid credentials")
                }
                is ApiResult.RateLimited -> {
                    AuthResult.Error("RATE_LIMITED", "Too many login attempts. Please try again later.")
                }
            }

        /**
         * Logs out the current user.
         *
         * Clears the local session and attempts to invalidate it on the server.
         * The session is always cleared locally, even if the server call fails.
         *
         * @return AuthResult indicating success or the type of failure
         */
        suspend fun logout(): AuthResult {
            // Always clear local session, regardless of API result
            val apiResult = api.logout()
            sessionStore.clearSession()

            return when (apiResult) {
                is ApiResult.Success -> {
                    AuthResult.Success(User(id = "", email = ""))
                }
                is ApiResult.Error -> {
                    // Session was cleared locally, but API failed
                    // We still consider this a success since the user is logged out locally
                    AuthResult.Success(User(id = "", email = ""))
                }
                is ApiResult.NetworkError -> {
                    // Session was cleared locally
                    AuthResult.Success(User(id = "", email = ""))
                }
                is ApiResult.Unauthorized -> {
                    // Already logged out or session expired
                    AuthResult.Success(User(id = "", email = ""))
                }
                is ApiResult.RateLimited -> {
                    // Session was cleared locally
                    AuthResult.Success(User(id = "", email = ""))
                }
            }
        }

        /**
         * Checks if the user is currently logged in.
         *
         * @return true if a valid session token exists
         */
        fun isLoggedIn(): Boolean = sessionStore.hasSession()

        /**
         * Gets the current authenticated user's information from the server.
         *
         * @return AuthResult containing the user data or an error
         */
        suspend fun getCurrentUser(): AuthResult =
            when (val result = api.me()) {
                is ApiResult.Success -> {
                    AuthResult.Success(result.data.user)
                }
                is ApiResult.Error -> {
                    AuthResult.Error(result.code, result.message)
                }
                is ApiResult.NetworkError -> {
                    AuthResult.NetworkError
                }
                is ApiResult.Unauthorized -> {
                    // Session is invalid, clear it
                    sessionStore.clearSession()
                    AuthResult.Error("UNAUTHORIZED", "Session expired. Please log in again.")
                }
                is ApiResult.RateLimited -> {
                    AuthResult.Error("RATE_LIMITED", "Too many requests. Please try again later.")
                }
            }

        /**
         * Gets the stored user ID.
         *
         * @return The user ID if logged in, null otherwise
         */
        fun getUserId(): String? = sessionStore.getUserId()

        /**
         * Gets the stored user email.
         *
         * @return The email if logged in, null otherwise
         */
        fun getEmail(): String? = sessionStore.getEmail()
    }
