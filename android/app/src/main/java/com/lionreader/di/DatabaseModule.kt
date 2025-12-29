package com.lionreader.di

import android.content.Context
import androidx.room.Room
import com.lionreader.data.db.LionReaderDatabase
import com.lionreader.data.db.dao.EntryDao
import com.lionreader.data.db.dao.EntryStateDao
import com.lionreader.data.db.dao.PendingActionDao
import com.lionreader.data.db.dao.SubscriptionDao
import com.lionreader.data.db.dao.TagDao
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

/**
 * Hilt module for Room database dependencies.
 *
 * Provides singleton instances of the database and all DAOs.
 */
@Module
@InstallIn(SingletonComponent::class)
object DatabaseModule {
    /**
     * Provides the Room database instance.
     *
     * The database is created as a singleton and persists for the app's lifetime.
     * Uses fallbackToDestructiveMigration for development; should be replaced
     * with proper migrations before production release.
     */
    @Provides
    @Singleton
    fun provideLionReaderDatabase(
        @ApplicationContext context: Context,
    ): LionReaderDatabase =
        Room
            .databaseBuilder(
                context,
                LionReaderDatabase::class.java,
                LionReaderDatabase.DATABASE_NAME,
            )
            // TODO: Add proper migrations before production release
            .fallbackToDestructiveMigration()
            .build()

    /**
     * Provides the EntryDao.
     */
    @Provides
    fun provideEntryDao(database: LionReaderDatabase): EntryDao = database.entryDao()

    /**
     * Provides the EntryStateDao.
     */
    @Provides
    fun provideEntryStateDao(database: LionReaderDatabase): EntryStateDao = database.entryStateDao()

    /**
     * Provides the PendingActionDao.
     */
    @Provides
    fun providePendingActionDao(database: LionReaderDatabase): PendingActionDao = database.pendingActionDao()

    /**
     * Provides the SubscriptionDao.
     */
    @Provides
    fun provideSubscriptionDao(database: LionReaderDatabase): SubscriptionDao = database.subscriptionDao()

    /**
     * Provides the TagDao.
     */
    @Provides
    fun provideTagDao(database: LionReaderDatabase): TagDao = database.tagDao()
}
