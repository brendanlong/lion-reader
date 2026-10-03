package com.lionreader.shared.account

import com.lionreader.shared.auth.StoredTokens
import com.lionreader.shared.auth.TokenStore

/**
 * The platform's small durable store: what [edit] writes is on disk when it returns. It holds the
 * refresh token ([KeyValueTokenStore]), so it's app-private storage: SharedPreferences on Android,
 * the Keychain on iOS (never NSUserDefaults).
 */
interface KeyValueStore {
    fun getString(key: String): String?

    fun getBoolean(key: String, default: Boolean): Boolean

    fun getLong(key: String, default: Long): Long

    fun edit(changes: Editor.() -> Unit)

    interface Editor {
        /** A null [value] removes the key. */
        fun putString(key: String, value: String?)

        fun putBoolean(key: String, value: Boolean)

        fun putLong(key: String, value: Long)

        fun remove(key: String)
    }
}

/**
 * Tokens in a [KeyValueStore], so a rotated refresh token is on disk before it is used (the old one
 * is dead by then).
 */
class KeyValueTokenStore(private val store: KeyValueStore) : TokenStore {
    override fun load(): StoredTokens? {
        val access = store.getString("access_token") ?: return null
        val refresh = store.getString("refresh_token") ?: return null
        return StoredTokens(access, refresh, store.getLong("access_expires_at", 0))
    }

    override fun save(tokens: StoredTokens?) {
        store.edit {
            putString("access_token", tokens?.accessToken)
            putString("refresh_token", tokens?.refreshToken)
            putLong("access_expires_at", tokens?.accessTokenExpiresAtMillis ?: 0)
        }
    }
}
