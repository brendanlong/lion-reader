package com.lionreader.data.sync

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Data class representing a sync error to be displayed to the user.
 */
data class SyncError(
    val message: String,
    val isAuthError: Boolean = false,
)

/**
 * Singleton for emitting sync errors that UI components can observe.
 *
 * This allows background sync operations (SyncWorker, SyncRepository) to
 * communicate errors to the UI layer without direct coupling.
 *
 * Usage:
 * ```kotlin
 * // In repository/worker - emit an error
 * syncErrorNotifier.emit(SyncError("Sync error: Failed to connect"))
 *
 * // In ViewModel/Screen - observe errors
 * syncErrorNotifier.errors.collect { error ->
 *     showToast(error.message)
 * }
 * ```
 */
@Singleton
class SyncErrorNotifier
    @Inject
    constructor() {
        private val _errors =
            MutableSharedFlow<SyncError>(
                replay = 0,
                extraBufferCapacity = 10,
            )

        /**
         * Flow of sync errors for UI components to observe.
         *
         * Errors are emitted once and not replayed, so each error is
         * shown only once even if multiple collectors are active.
         */
        val errors: SharedFlow<SyncError> = _errors.asSharedFlow()

        /**
         * Emits a sync error to be displayed to the user.
         *
         * @param error The sync error to emit
         */
        suspend fun emit(error: SyncError) {
            _errors.emit(error)
        }

        /**
         * Emits a sync error with just a message.
         *
         * @param message The error message to display
         * @param isAuthError Whether this is an authentication error
         */
        suspend fun emit(
            message: String,
            isAuthError: Boolean = false,
        ) {
            _errors.emit(SyncError(message, isAuthError))
        }
    }
