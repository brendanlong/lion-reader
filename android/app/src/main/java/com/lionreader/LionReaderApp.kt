package com.lionreader

import android.app.Application
import android.util.Log
import androidx.hilt.work.HiltWorkerFactory
import androidx.work.Configuration
import com.lionreader.data.sync.SyncScheduler
import dagger.hilt.android.HiltAndroidApp
import io.sentry.android.core.SentryAndroid
import io.sentry.android.core.SentryAndroidOptions
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

        // Initialize Sentry for error monitoring
        initializeSentry()

        // Initialize background sync scheduler
        // This sets up periodic sync and connectivity-triggered sync
        initializeSyncScheduler()

        Log.d(TAG, "Application initialized")
    }

    /**
     * Initializes Sentry for error monitoring and crash reporting.
     *
     * Sentry is only initialized if a valid DSN is configured via the
     * SENTRY_DSN environment variable at build time. If no DSN is provided,
     * Sentry remains disabled.
     */
    private fun initializeSentry() {
        val dsn = BuildConfig.SENTRY_DSN
        if (dsn.isBlank()) {
            Log.d(TAG, "Sentry DSN not configured, skipping initialization")
            return
        }

        try {
            SentryAndroid.init(this) { options: SentryAndroidOptions ->
                options.dsn = dsn

                // Set the environment based on build type
                options.environment = if (BuildConfig.DEBUG) "development" else "production"

                // Set the release version
                options.release = "${BuildConfig.APPLICATION_ID}@${BuildConfig.VERSION_NAME}+${BuildConfig.VERSION_CODE}"

                // Enable automatic session tracking
                options.isEnableAutoSessionTracking = true

                // Set sample rates for performance monitoring
                // Capture 100% of transactions for performance monitoring
                options.tracesSampleRate = 1.0

                // Add app version as a tag for filtering
                options.setTag("app.version", BuildConfig.VERSION_NAME)
                options.setTag("app.version_code", BuildConfig.VERSION_CODE.toString())
            }
            Log.d(TAG, "Sentry initialized successfully")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to initialize Sentry", e)
        }
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
