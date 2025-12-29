package com.lionreader.data.api

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Secure storage for session tokens and user information.
 *
 * Uses EncryptedSharedPreferences for secure storage of sensitive data like
 * authentication tokens. All data is encrypted using AES256-GCM.
 */
@Singleton
class SessionStore
    @Inject
    constructor(
        @ApplicationContext private val context: Context,
    ) {
        private val masterKey: MasterKey by lazy {
            MasterKey
                .Builder(context)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
        }

        private val encryptedPrefs: SharedPreferences by lazy {
            EncryptedSharedPreferences.create(
                context,
                PREFS_FILE_NAME,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
        }

        private val _isLoggedIn = MutableStateFlow(getToken() != null)

        /**
         * Observable state of whether the user is logged in.
         */
        val isLoggedIn: StateFlow<Boolean> = _isLoggedIn.asStateFlow()

        /**
         * Saves the session information.
         *
         * @param token The session token
         * @param userId The user's ID
         * @param email The user's email
         */
        fun saveSession(
            token: String,
            userId: String,
            email: String,
        ) {
            encryptedPrefs
                .edit()
                .putString(KEY_TOKEN, token)
                .putString(KEY_USER_ID, userId)
                .putString(KEY_EMAIL, email)
                .putLong(KEY_SAVED_AT, System.currentTimeMillis())
                .apply()
            _isLoggedIn.value = true
        }

        /**
         * Gets the current session token.
         *
         * @return The token if present, null otherwise
         */
        fun getToken(): String? = encryptedPrefs.getString(KEY_TOKEN, null)

        /**
         * Gets the current user's ID.
         *
         * @return The user ID if present, null otherwise
         */
        fun getUserId(): String? = encryptedPrefs.getString(KEY_USER_ID, null)

        /**
         * Gets the current user's email.
         *
         * @return The email if present, null otherwise
         */
        fun getEmail(): String? = encryptedPrefs.getString(KEY_EMAIL, null)

        /**
         * Gets the timestamp when the session was saved.
         *
         * @return The timestamp in milliseconds, or null if no session exists
         */
        fun getSavedAt(): Long? {
            val savedAt = encryptedPrefs.getLong(KEY_SAVED_AT, -1L)
            return if (savedAt == -1L) null else savedAt
        }

        /**
         * Clears all session data.
         *
         * This should be called when the user logs out or when the session
         * is invalidated by the server.
         */
        fun clearSession() {
            encryptedPrefs
                .edit()
                .remove(KEY_TOKEN)
                .remove(KEY_USER_ID)
                .remove(KEY_EMAIL)
                .remove(KEY_SAVED_AT)
                .apply()
            _isLoggedIn.value = false
        }

        /**
         * Checks if the user is currently logged in.
         *
         * @return true if a session token exists
         */
        fun hasSession(): Boolean = getToken() != null

        companion object {
            private const val PREFS_FILE_NAME = "lion_reader_auth_secure"
            private const val KEY_TOKEN = "session_token"
            private const val KEY_USER_ID = "user_id"
            private const val KEY_EMAIL = "email"
            private const val KEY_SAVED_AT = "saved_at"
        }
    }
