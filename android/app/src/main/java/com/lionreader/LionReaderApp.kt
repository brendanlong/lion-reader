package com.lionreader

import android.app.Application
import android.util.Log
import androidx.hilt.work.HiltWorkerFactory
import androidx.work.Configuration
import com.lionreader.data.sync.SyncScheduler
import dagger.hilt.android.HiltAndroidApp
import javax.inject.Inject

/**
 * Main Application class for Lion Reader.
 *
 * This class serves as the entry point for application-wide initialization.
 * The @HiltAndroidApp annotation triggers Hilt's code generation and serves
 * as the application-level dependency container.
 *
 * Implements [Configuration.Provider] to configure WorkManager with Hilt support.
 */
@HiltAndroidApp
class LionReaderApp :
    Application(),
    Configuration.Provider {
    companion object {
        private const val TAG = "LionReaderApp"
    }

    /**
     * Hilt WorkerFactory for injecting dependencies into Workers.
     */
    @Inject
    lateinit var workerFactory: HiltWorkerFactory

    /**
     * Sync scheduler for managing background sync operations.
     */
    @Inject
    lateinit var syncScheduler: SyncScheduler

    override fun onCreate() {
        super.onCreate()

        Log.d(TAG, "Application starting...")

        // Initialize background sync scheduler
        // This sets up periodic sync and connectivity-triggered sync
        initializeSyncScheduler()

        Log.d(TAG, "Application initialized")
    }

    /**
     * Initializes the background sync scheduler.
     *
     * This schedules periodic sync every 15 minutes and sets up
     * connectivity restoration callbacks to trigger immediate sync.
     */
    private fun initializeSyncScheduler() {
        try {
            syncScheduler.initialize()
            Log.d(TAG, "Sync scheduler initialized")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to initialize sync scheduler", e)
        }
    }

    /**
     * Provides WorkManager configuration with Hilt worker factory.
     *
     * This enables dependency injection in WorkManager workers via @HiltWorker.
     */
    override val workManagerConfiguration: Configuration
        get() =
            Configuration
                .Builder()
                .setWorkerFactory(workerFactory)
                .setMinimumLoggingLevel(Log.DEBUG)
                .build()
}
