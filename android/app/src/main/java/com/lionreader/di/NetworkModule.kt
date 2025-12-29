package com.lionreader.di

import com.lionreader.data.api.ApiClient
import com.lionreader.data.api.LionReaderApi
import com.lionreader.data.api.LionReaderApiImpl
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import io.ktor.client.HttpClient
import javax.inject.Singleton

/**
 * Hilt module for network/API dependencies.
 *
 * This module provides all network-related dependencies including:
 * - SessionStore for secure token storage
 * - AuthInterceptor for authentication header injection
 * - ApiClient for HTTP communication
 * - LionReaderApi for typed API access
 */
@Module
@InstallIn(SingletonComponent::class)
object NetworkModule {
    /**
     * Provides the HttpClient instance from ApiClient.
     *
     * This is exposed for cases where direct access to the HTTP client is needed,
     * such as for testing or specialized requests.
     */
    @Provides
    @Singleton
    fun provideHttpClient(apiClient: ApiClient): HttpClient = apiClient.httpClient

    /**
     * Provides the LionReaderApi implementation.
     *
     * The implementation is bound to the interface to allow for
     * testing with mock implementations.
     */
    @Provides
    @Singleton
    fun provideLionReaderApi(apiClient: ApiClient): LionReaderApi = LionReaderApiImpl(apiClient)
}
