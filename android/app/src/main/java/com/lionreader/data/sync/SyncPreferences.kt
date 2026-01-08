package com.lionreader.data.sync

import android.content.Context
import android.content.SharedPreferences
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Storage for sync-related preferences.
 *
 * Stores the last sync timestamp used for incremental sync operations.
 */
@Singleton
class SyncPreferences
    @Inject
    constructor(
        @ApplicationContext private val context: Context,
    ) {
        private val prefs: SharedPreferences by lazy {
            context.getSharedPreferences(PREFS_FILE_NAME, Context.MODE_PRIVATE)
        }

        /**
         * Gets the last sync timestamp.
         *
         * @return ISO 8601 timestamp of the last successful sync, or null for initial sync
         */
        fun getLastSyncedAt(): String? = prefs.getString(KEY_LAST_SYNCED_AT, null)

        /**
         * Saves the last sync timestamp.
         *
         * @param syncedAt ISO 8601 timestamp from the server's sync response
         */
        fun setLastSyncedAt(syncedAt: String) {
            prefs.edit().putString(KEY_LAST_SYNCED_AT, syncedAt).apply()
        }

        /**
         * Clears the last sync timestamp.
         *
         * This forces a full sync on the next sync operation.
         */
        fun clearLastSyncedAt() {
            prefs.edit().remove(KEY_LAST_SYNCED_AT).apply()
        }

        /**
         * Clears all sync preferences.
         *
         * Called when logging out to reset sync state.
         */
        fun clear() {
            prefs.edit().clear().apply()
        }

        companion object {
            private const val PREFS_FILE_NAME = "lion_reader_sync"
            private const val KEY_LAST_SYNCED_AT = "last_synced_at"
        }
    }
