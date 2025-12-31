package com.lionreader.di

import com.lionreader.data.api.LionReaderApi
import com.lionreader.data.api.SessionStore
import com.lionreader.data.db.dao.EntryDao
import com.lionreader.data.db.dao.EntryStateDao
import com.lionreader.data.db.dao.PendingActionDao
import com.lionreader.data.db.dao.SubscriptionDao
import com.lionreader.data.db.dao.TagDao
import com.lionreader.data.repository.AuthRepository
import com.lionreader.data.repository.EntryRepository
import com.lionreader.data.repository.SubscriptionRepository
import com.lionreader.data.repository.SyncRepository
import com.lionreader.data.repository.TagRepository
import com.lionreader.data.sync.ConnectivityMonitor
import com.lionreader.data.sync.SyncErrorNotifier
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

/**
 * Hilt module for repository dependencies.
 *
 * This module provides all repository instances for the application.
 * Repositories coordinate between the API layer and local database,
 * implementing the offline-first data strategy.
 *
 * Available repositories:
 * - AuthRepository: Authentication and session management
 * - SubscriptionRepository: Feed subscriptions
 * - TagRepository: Subscription tags
 * - EntryRepository: Feed entries with read/star state
 * - SyncRepository: Offline action synchronization
 */
@Module
@InstallIn(SingletonComponent::class)
object RepositoryModule {
    /**
     * Provides the AuthRepository for authentication operations.
     *
     * Handles login, logout, and session management.
     */
    @Provides
    @Singleton
    fun provideAuthRepository(
        api: LionReaderApi,
        sessionStore: SessionStore,
    ): AuthRepository = AuthRepository(api, sessionStore)

    /**
     * Provides the SubscriptionRepository for subscription operations.
     *
     * Manages feed subscriptions with offline-first access.
     */
    @Provides
    @Singleton
    fun provideSubscriptionRepository(
        api: LionReaderApi,
        subscriptionDao: SubscriptionDao,
        tagDao: TagDao,
    ): SubscriptionRepository = SubscriptionRepository(api, subscriptionDao, tagDao)

    /**
     * Provides the TagRepository for tag operations.
     *
     * Manages subscription tags with offline-first access.
     */
    @Provides
    @Singleton
    fun provideTagRepository(
        api: LionReaderApi,
        tagDao: TagDao,
    ): TagRepository = TagRepository(api, tagDao)

    /**
     * Provides the EntryRepository for entry operations.
     *
     * Manages feed entries with read/star state and offline support.
     * Also handles full sync from server including subscriptions, tags, and entries.
     */
    @Provides
    @Singleton
    fun provideEntryRepository(
        api: LionReaderApi,
        entryDao: EntryDao,
        entryStateDao: EntryStateDao,
        pendingActionDao: PendingActionDao,
        subscriptionDao: SubscriptionDao,
        tagDao: TagDao,
        connectivityMonitor: ConnectivityMonitor,
        syncRepository: SyncRepository,
    ): EntryRepository =
        EntryRepository(
            api,
            entryDao,
            entryStateDao,
            pendingActionDao,
            subscriptionDao,
            tagDao,
            connectivityMonitor,
            syncRepository,
        )

    /**
     * Provides the SyncRepository for synchronization operations.
     *
     * Handles syncing pending offline actions to the server.
     */
    @Provides
    @Singleton
    fun provideSyncRepository(
        api: LionReaderApi,
        pendingActionDao: PendingActionDao,
        entryStateDao: EntryStateDao,
        syncErrorNotifier: SyncErrorNotifier,
    ): SyncRepository = SyncRepository(api, pendingActionDao, entryStateDao, syncErrorNotifier)
}
