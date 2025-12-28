package com.lionreader.di

import dagger.Module
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent

/**
 * Hilt module for network/API dependencies.
 *
 * This module will provide:
 * - Ktor HttpClient
 * - LionReaderApi implementation
 * - JSON serialization (kotlinx.serialization)
 *
 * TODO: Implement when Ktor is added:
 * - Add Ktor dependencies to build.gradle.kts
 * - Create API interface and implementation
 * - Configure HTTP client with auth interceptor
 * - Provide API instance here
 */
@Module
@InstallIn(SingletonComponent::class)
object NetworkModule {
    // Network and API providers will be added here when Ktor is configured.
    // Example:
    //
    // @Provides
    // @Singleton
    // fun provideHttpClient(appConfig: AppConfig): HttpClient {
    //     return HttpClient(CIO) {
    //         install(ContentNegotiation) {
    //             json(Json {
    //                 ignoreUnknownKeys = true
    //                 isLenient = true
    //             })
    //         }
    //         install(Logging) {
    //             level = if (appConfig.isDebug) LogLevel.ALL else LogLevel.NONE
    //         }
    //         defaultRequest {
    //             url(appConfig.fullApiUrl)
    //         }
    //     }
    // }
    //
    // @Provides
    // @Singleton
    // fun provideLionReaderApi(httpClient: HttpClient): LionReaderApi {
    //     return LionReaderApiImpl(httpClient)
    // }
}
