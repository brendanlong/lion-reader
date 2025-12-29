package com.lionreader.di

import android.content.Context
import com.lionreader.BuildConfig
import com.lionreader.data.sync.ConnectivityMonitor
import com.lionreader.data.sync.ConnectivityMonitorInterface
import dagger.Binds
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

/**
 * Application-level Hilt module providing core dependencies.
 *
 * This module provides dependencies that are scoped to the application
 * lifecycle and should be available throughout the app.
 */
@Module
@InstallIn(SingletonComponent::class)
object AppModule {
    @Provides
    @Singleton
    fun provideAppConfig(
        @ApplicationContext context: Context,
    ): AppConfig =
        AppConfig(
            appName = context.getString(context.applicationInfo.labelRes),
            apiBaseUrl = BuildConfig.API_BASE_URL,
            apiBasePath = BuildConfig.API_BASE_PATH,
            isDebug = BuildConfig.DEBUG,
        )
}

/**
 * Hilt bindings module for interface implementations.
 */
@Module
@InstallIn(SingletonComponent::class)
abstract class AppBindingsModule {
    @Binds
    @Singleton
    abstract fun bindConnectivityMonitor(impl: ConnectivityMonitor): ConnectivityMonitorInterface
}

/**
 * Application configuration data class.
 *
 * Holds configuration values that are needed throughout the app.
 * This is injected where needed to avoid hardcoding configuration values.
 */
data class AppConfig(
    val appName: String,
    val apiBaseUrl: String,
    val apiBasePath: String,
    val isDebug: Boolean,
) {
    /**
     * Full API URL combining base URL and path.
     */
    val fullApiUrl: String
        get() = "$apiBaseUrl$apiBasePath"
}
