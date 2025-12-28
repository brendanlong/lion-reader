package com.lionreader

import android.app.Application
import dagger.hilt.android.HiltAndroidApp

/**
 * Main Application class for Lion Reader.
 *
 * This class serves as the entry point for application-wide initialization.
 * The @HiltAndroidApp annotation triggers Hilt's code generation and serves
 * as the application-level dependency container.
 *
 * Future implementations will include:
 * - WorkManager initialization for background sync
 * - Crash reporting and analytics initialization
 */
@HiltAndroidApp
class LionReaderApp : Application() {

    override fun onCreate() {
        super.onCreate()
        // TODO: Initialize WorkManager for background sync
        // TODO: Initialize crash reporting
    }
}
