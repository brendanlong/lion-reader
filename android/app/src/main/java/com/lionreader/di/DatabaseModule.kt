package com.lionreader.di

import dagger.Module
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent

/**
 * Hilt module for Room database dependencies.
 *
 * This module will provide:
 * - LionReaderDatabase instance
 * - DAOs (EntryDao, SubscriptionDao, TagDao, etc.)
 *
 * TODO: Implement when Room is added:
 * - Add Room dependencies to build.gradle.kts
 * - Create database entities
 * - Create DAOs
 * - Provide database instance here
 */
@Module
@InstallIn(SingletonComponent::class)
object DatabaseModule {
    // Database and DAO providers will be added here when Room is configured.
    // Example:
    //
    // @Provides
    // @Singleton
    // fun provideLionReaderDatabase(@ApplicationContext context: Context): LionReaderDatabase {
    //     return Room.databaseBuilder(
    //         context,
    //         LionReaderDatabase::class.java,
    //         "lionreader.db"
    //     ).build()
    // }
    //
    // @Provides
    // fun provideEntryDao(database: LionReaderDatabase): EntryDao {
    //     return database.entryDao()
    // }
}
