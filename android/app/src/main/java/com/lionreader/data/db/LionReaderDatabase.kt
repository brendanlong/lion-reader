package com.lionreader.data.db

import androidx.room.Database
import androidx.room.RoomDatabase
import com.lionreader.data.db.dao.EntryDao
import com.lionreader.data.db.dao.EntryStateDao
import com.lionreader.data.db.dao.PendingActionDao
import com.lionreader.data.db.dao.SubscriptionDao
import com.lionreader.data.db.dao.TagDao
import com.lionreader.data.db.entities.EntryEntity
import com.lionreader.data.db.entities.EntryStateEntity
import com.lionreader.data.db.entities.FeedEntity
import com.lionreader.data.db.entities.PendingActionEntity
import com.lionreader.data.db.entities.SessionEntity
import com.lionreader.data.db.entities.SubscriptionEntity
import com.lionreader.data.db.entities.SubscriptionTagEntity
import com.lionreader.data.db.entities.TagEntity

/**
 * Room database for Lion Reader.
 *
 * Contains all local data including:
 * - User session information
 * - Feed subscriptions and their content
 * - Entry read/starred states
 * - Tags for organizing subscriptions
 * - Pending offline actions queue
 *
 * Database version history:
 * - Version 1: Initial schema with all core entities
 * - Version 2: Remove foreign key from entries.feedId to feeds.id
 * - Version 3: Add unreadCount column to tags table
 */
@Database(
    entities = [
        SessionEntity::class,
        FeedEntity::class,
        SubscriptionEntity::class,
        EntryEntity::class,
        EntryStateEntity::class,
        TagEntity::class,
        SubscriptionTagEntity::class,
        PendingActionEntity::class,
    ],
    version = LionReaderDatabase.VERSION,
    exportSchema = true,
)
abstract class LionReaderDatabase : RoomDatabase() {
    /**
     * Entry data access object
     */
    abstract fun entryDao(): EntryDao

    /**
     * Entry state data access object
     */
    abstract fun entryStateDao(): EntryStateDao

    /**
     * Pending action data access object
     */
    abstract fun pendingActionDao(): PendingActionDao

    /**
     * Subscription data access object
     */
    abstract fun subscriptionDao(): SubscriptionDao

    /**
     * Tag data access object
     */
    abstract fun tagDao(): TagDao

    companion object {
        /**
         * Current database version.
         *
         * Increment when schema changes require a migration.
         */
        const val VERSION = 3

        /**
         * Database file name.
         */
        const val DATABASE_NAME = "lionreader.db"
    }
}
