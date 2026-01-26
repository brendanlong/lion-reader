package com.lionreader.data.db;

import androidx.annotation.NonNull;
import androidx.room.DatabaseConfiguration;
import androidx.room.InvalidationTracker;
import androidx.room.RoomDatabase;
import androidx.room.RoomOpenHelper;
import androidx.room.migration.AutoMigrationSpec;
import androidx.room.migration.Migration;
import androidx.room.util.DBUtil;
import androidx.room.util.TableInfo;
import androidx.sqlite.db.SupportSQLiteDatabase;
import androidx.sqlite.db.SupportSQLiteOpenHelper;
import com.lionreader.data.db.dao.EntryDao;
import com.lionreader.data.db.dao.EntryDao_Impl;
import com.lionreader.data.db.dao.EntryStateDao;
import com.lionreader.data.db.dao.EntryStateDao_Impl;
import com.lionreader.data.db.dao.PendingActionDao;
import com.lionreader.data.db.dao.PendingActionDao_Impl;
import com.lionreader.data.db.dao.SubscriptionDao;
import com.lionreader.data.db.dao.SubscriptionDao_Impl;
import com.lionreader.data.db.dao.TagDao;
import com.lionreader.data.db.dao.TagDao_Impl;
import java.lang.Class;
import java.lang.Override;
import java.lang.String;
import java.lang.SuppressWarnings;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import javax.annotation.processing.Generated;

@Generated("androidx.room.RoomProcessor")
@SuppressWarnings({"unchecked", "deprecation"})
public final class LionReaderDatabase_Impl extends LionReaderDatabase {
  private volatile EntryDao _entryDao;

  private volatile EntryStateDao _entryStateDao;

  private volatile PendingActionDao _pendingActionDao;

  private volatile SubscriptionDao _subscriptionDao;

  private volatile TagDao _tagDao;

  @Override
  @NonNull
  protected SupportSQLiteOpenHelper createOpenHelper(@NonNull final DatabaseConfiguration config) {
    final SupportSQLiteOpenHelper.Callback _openCallback = new RoomOpenHelper(config, new RoomOpenHelper.Delegate(3) {
      @Override
      public void createAllTables(@NonNull final SupportSQLiteDatabase db) {
        db.execSQL("CREATE TABLE IF NOT EXISTS `sessions` (`token` TEXT NOT NULL, `userId` TEXT NOT NULL, `email` TEXT NOT NULL, `createdAt` INTEGER NOT NULL, `expiresAt` INTEGER, PRIMARY KEY(`token`))");
        db.execSQL("CREATE TABLE IF NOT EXISTS `feeds` (`id` TEXT NOT NULL, `type` TEXT NOT NULL, `url` TEXT, `title` TEXT, `description` TEXT, `siteUrl` TEXT, `lastSyncedAt` INTEGER NOT NULL, PRIMARY KEY(`id`))");
        db.execSQL("CREATE TABLE IF NOT EXISTS `subscriptions` (`id` TEXT NOT NULL, `feedId` TEXT NOT NULL, `customTitle` TEXT, `subscribedAt` INTEGER NOT NULL, `unreadCount` INTEGER NOT NULL, `lastSyncedAt` INTEGER NOT NULL, PRIMARY KEY(`id`), FOREIGN KEY(`feedId`) REFERENCES `feeds`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE )");
        db.execSQL("CREATE INDEX IF NOT EXISTS `index_subscriptions_feedId` ON `subscriptions` (`feedId`)");
        db.execSQL("CREATE TABLE IF NOT EXISTS `entries` (`id` TEXT NOT NULL, `feedId` TEXT NOT NULL, `url` TEXT, `title` TEXT, `author` TEXT, `summary` TEXT, `contentOriginal` TEXT, `contentCleaned` TEXT, `publishedAt` INTEGER, `fetchedAt` INTEGER NOT NULL, `feedTitle` TEXT, `lastSyncedAt` INTEGER NOT NULL, PRIMARY KEY(`id`))");
        db.execSQL("CREATE INDEX IF NOT EXISTS `index_entries_feedId` ON `entries` (`feedId`)");
        db.execSQL("CREATE INDEX IF NOT EXISTS `index_entries_fetchedAt` ON `entries` (`fetchedAt`)");
        db.execSQL("CREATE INDEX IF NOT EXISTS `index_entries_publishedAt` ON `entries` (`publishedAt`)");
        db.execSQL("CREATE TABLE IF NOT EXISTS `entry_states` (`entryId` TEXT NOT NULL, `read` INTEGER NOT NULL, `starred` INTEGER NOT NULL, `readAt` INTEGER, `starredAt` INTEGER, `pendingSync` INTEGER NOT NULL, `lastModifiedAt` INTEGER NOT NULL, PRIMARY KEY(`entryId`), FOREIGN KEY(`entryId`) REFERENCES `entries`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE )");
        db.execSQL("CREATE INDEX IF NOT EXISTS `index_entry_states_entryId` ON `entry_states` (`entryId`)");
        db.execSQL("CREATE INDEX IF NOT EXISTS `index_entry_states_pendingSync` ON `entry_states` (`pendingSync`)");
        db.execSQL("CREATE TABLE IF NOT EXISTS `tags` (`id` TEXT NOT NULL, `name` TEXT NOT NULL, `color` TEXT, `feedCount` INTEGER NOT NULL, `unreadCount` INTEGER NOT NULL, PRIMARY KEY(`id`))");
        db.execSQL("CREATE TABLE IF NOT EXISTS `subscription_tags` (`subscriptionId` TEXT NOT NULL, `tagId` TEXT NOT NULL, PRIMARY KEY(`subscriptionId`, `tagId`), FOREIGN KEY(`subscriptionId`) REFERENCES `subscriptions`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE , FOREIGN KEY(`tagId`) REFERENCES `tags`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE )");
        db.execSQL("CREATE INDEX IF NOT EXISTS `index_subscription_tags_subscriptionId` ON `subscription_tags` (`subscriptionId`)");
        db.execSQL("CREATE INDEX IF NOT EXISTS `index_subscription_tags_tagId` ON `subscription_tags` (`tagId`)");
        db.execSQL("CREATE TABLE IF NOT EXISTS `pending_actions` (`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, `type` TEXT NOT NULL, `entryId` TEXT NOT NULL, `createdAt` INTEGER NOT NULL, `retryCount` INTEGER NOT NULL, FOREIGN KEY(`entryId`) REFERENCES `entries`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE )");
        db.execSQL("CREATE INDEX IF NOT EXISTS `index_pending_actions_entryId` ON `pending_actions` (`entryId`)");
        db.execSQL("CREATE INDEX IF NOT EXISTS `index_pending_actions_createdAt` ON `pending_actions` (`createdAt`)");
        db.execSQL("CREATE TABLE IF NOT EXISTS room_master_table (id INTEGER PRIMARY KEY,identity_hash TEXT)");
        db.execSQL("INSERT OR REPLACE INTO room_master_table (id,identity_hash) VALUES(42, '841f08db11fdc4e64a292f5ebb0db325')");
      }

      @Override
      public void dropAllTables(@NonNull final SupportSQLiteDatabase db) {
        db.execSQL("DROP TABLE IF EXISTS `sessions`");
        db.execSQL("DROP TABLE IF EXISTS `feeds`");
        db.execSQL("DROP TABLE IF EXISTS `subscriptions`");
        db.execSQL("DROP TABLE IF EXISTS `entries`");
        db.execSQL("DROP TABLE IF EXISTS `entry_states`");
        db.execSQL("DROP TABLE IF EXISTS `tags`");
        db.execSQL("DROP TABLE IF EXISTS `subscription_tags`");
        db.execSQL("DROP TABLE IF EXISTS `pending_actions`");
        final List<? extends RoomDatabase.Callback> _callbacks = mCallbacks;
        if (_callbacks != null) {
          for (RoomDatabase.Callback _callback : _callbacks) {
            _callback.onDestructiveMigration(db);
          }
        }
      }

      @Override
      public void onCreate(@NonNull final SupportSQLiteDatabase db) {
        final List<? extends RoomDatabase.Callback> _callbacks = mCallbacks;
        if (_callbacks != null) {
          for (RoomDatabase.Callback _callback : _callbacks) {
            _callback.onCreate(db);
          }
        }
      }

      @Override
      public void onOpen(@NonNull final SupportSQLiteDatabase db) {
        mDatabase = db;
        db.execSQL("PRAGMA foreign_keys = ON");
        internalInitInvalidationTracker(db);
        final List<? extends RoomDatabase.Callback> _callbacks = mCallbacks;
        if (_callbacks != null) {
          for (RoomDatabase.Callback _callback : _callbacks) {
            _callback.onOpen(db);
          }
        }
      }

      @Override
      public void onPreMigrate(@NonNull final SupportSQLiteDatabase db) {
        DBUtil.dropFtsSyncTriggers(db);
      }

      @Override
      public void onPostMigrate(@NonNull final SupportSQLiteDatabase db) {
      }

      @Override
      @NonNull
      public RoomOpenHelper.ValidationResult onValidateSchema(
          @NonNull final SupportSQLiteDatabase db) {
        final HashMap<String, TableInfo.Column> _columnsSessions = new HashMap<String, TableInfo.Column>(5);
        _columnsSessions.put("token", new TableInfo.Column("token", "TEXT", true, 1, null, TableInfo.CREATED_FROM_ENTITY));
        _columnsSessions.put("userId", new TableInfo.Column("userId", "TEXT", true, 0, null, TableInfo.CREATED_FROM_ENTITY));
        _columnsSessions.put("email", new TableInfo.Column("email", "TEXT", true, 0, null, TableInfo.CREATED_FROM_ENTITY));
        _columnsSessions.put("createdAt", new TableInfo.Column("createdAt", "INTEGER", true, 0, null, TableInfo.CREATED_FROM_ENTITY));
        _columnsSessions.put("expiresAt", new TableInfo.Column("expiresAt", "INTEGER", false, 0, null, TableInfo.CREATED_FROM_ENTITY));
        final HashSet<TableInfo.ForeignKey> _foreignKeysSessions = new HashSet<TableInfo.ForeignKey>(0);
        final HashSet<TableInfo.Index> _indicesSessions = new HashSet<TableInfo.Index>(0);
        final TableInfo _infoSessions = new TableInfo("sessions", _columnsSessions, _foreignKeysSessions, _indicesSessions);
        final TableInfo _existingSessions = TableInfo.read(db, "sessions");
        if (!_infoSessions.equals(_existingSessions)) {
          return new RoomOpenHelper.ValidationResult(false, "sessions(com.lionreader.data.db.entities.SessionEntity).\n"
                  + " Expected:\n" + _infoSessions + "\n"
                  + " Found:\n" + _existingSessions);
        }
        final HashMap<String, TableInfo.Column> _columnsFeeds = new HashMap<String, TableInfo.Column>(7);
        _columnsFeeds.put("id", new TableInfo.Column("id", "TEXT", true, 1, null, TableInfo.CREATED_FROM_ENTITY));
        _columnsFeeds.put("type", new TableInfo.Column("type", "TEXT", true, 0, null, TableInfo.CREATED_FROM_ENTITY));
        _columnsFeeds.put("url", new TableInfo.Column("url", "TEXT", false, 0, null, TableInfo.CREATED_FROM_ENTITY));
        _columnsFeeds.put("title", new TableInfo.Column("title", "TEXT", false, 0, null, TableInfo.CREATED_FROM_ENTITY));
        _columnsFeeds.put("description", new TableInfo.Column("description", "TEXT", false, 0, null, TableInfo.CREATED_FROM_ENTITY));
        _columnsFeeds.put("siteUrl", new TableInfo.Column("siteUrl", "TEXT", false, 0, null, TableInfo.CREATED_FROM_ENTITY));
        _columnsFeeds.put("lastSyncedAt", new TableInfo.Column("lastSyncedAt", "INTEGER", true, 0, null, TableInfo.CREATED_FROM_ENTITY));
        final HashSet<TableInfo.ForeignKey> _foreignKeysFeeds = new HashSet<TableInfo.ForeignKey>(0);
        final HashSet<TableInfo.Index> _indicesFeeds = new HashSet<TableInfo.Index>(0);
        final TableInfo _infoFeeds = new TableInfo("feeds", _columnsFeeds, _foreignKeysFeeds, _indicesFeeds);
        final TableInfo _existingFeeds = TableInfo.read(db, "feeds");
        if (!_infoFeeds.equals(_existingFeeds)) {
          return new RoomOpenHelper.ValidationResult(false, "feeds(com.lionreader.data.db.entities.FeedEntity).\n"
                  + " Expected:\n" + _infoFeeds + "\n"
                  + " Found:\n" + _existingFeeds);
        }
        final HashMap<String, TableInfo.Column> _columnsSubscriptions = new HashMap<String, TableInfo.Column>(6);
        _columnsSubscriptions.put("id", new TableInfo.Column("id", "TEXT", true, 1, null, TableInfo.CREATED_FROM_ENTITY));
        _columnsSubscriptions.put("feedId", new TableInfo.Column("feedId", "TEXT", true, 0, null, TableInfo.CREATED_FROM_ENTITY));
        _columnsSubscriptions.put("customTitle", new TableInfo.Column("customTitle", "TEXT", false, 0, null, TableInfo.CREATED_FROM_ENTITY));
        _columnsSubscriptions.put("subscribedAt", new TableInfo.Column("subscribedAt", "INTEGER", true, 0, null, TableInfo.CREATED_FROM_ENTITY));
        _columnsSubscriptions.put("unreadCount", new TableInfo.Column("unreadCount", "INTEGER", true, 0, null, TableInfo.CREATED_FROM_ENTITY));
        _columnsSubscriptions.put("lastSyncedAt", new TableInfo.Column("lastSyncedAt", "INTEGER", true, 0, null, TableInfo.CREATED_FROM_ENTITY));
        final HashSet<TableInfo.ForeignKey> _foreignKeysSubscriptions = new HashSet<TableInfo.ForeignKey>(1);
        _foreignKeysSubscriptions.add(new TableInfo.ForeignKey("feeds", "CASCADE", "NO ACTION", Arrays.asList("feedId"), Arrays.asList("id")));
        final HashSet<TableInfo.Index> _indicesSubscriptions = new HashSet<TableInfo.Index>(1);
        _indicesSubscriptions.add(new TableInfo.Index("index_subscriptions_feedId", false, Arrays.asList("feedId"), Arrays.asList("ASC")));
        final TableInfo _infoSubscriptions = new TableInfo("subscriptions", _columnsSubscriptions, _foreignKeysSubscriptions, _indicesSubscriptions);
        final TableInfo _existingSubscriptions = TableInfo.read(db, "subscriptions");
        if (!_infoSubscriptions.equals(_existingSubscriptions)) {
          return new RoomOpenHelper.ValidationResult(false, "subscriptions(com.lionreader.data.db.entities.SubscriptionEntity).\n"
                  + " Expected:\n" + _infoSubscriptions + "\n"
                  + " Found:\n" + _existingSubscriptions);
        }
        final HashMap<String, TableInfo.Column> _columnsEntries = new HashMap<String, TableInfo.Column>(12);
        _columnsEntries.put("id", new TableInfo.Column("id", "TEXT", true, 1, null, TableInfo.CREATED_FROM_ENTITY));
        _columnsEntries.put("feedId", new TableInfo.Column("feedId", "TEXT", true, 0, null, TableInfo.CREATED_FROM_ENTITY));
        _columnsEntries.put("url", new TableInfo.Column("url", "TEXT", false, 0, null, TableInfo.CREATED_FROM_ENTITY));
        _columnsEntries.put("title", new TableInfo.Column("title", "TEXT", false, 0, null, TableInfo.CREATED_FROM_ENTITY));
        _columnsEntries.put("author", new TableInfo.Column("author", "TEXT", false, 0, null, TableInfo.CREATED_FROM_ENTITY));
        _columnsEntries.put("summary", new TableInfo.Column("summary", "TEXT", false, 0, null, TableInfo.CREATED_FROM_ENTITY));
        _columnsEntries.put("contentOriginal", new TableInfo.Column("contentOriginal", "TEXT", false, 0, null, TableInfo.CREATED_FROM_ENTITY));
        _columnsEntries.put("contentCleaned", new TableInfo.Column("contentCleaned", "TEXT", false, 0, null, TableInfo.CREATED_FROM_ENTITY));
        _columnsEntries.put("publishedAt", new TableInfo.Column("publishedAt", "INTEGER", false, 0, null, TableInfo.CREATED_FROM_ENTITY));
        _columnsEntries.put("fetchedAt", new TableInfo.Column("fetchedAt", "INTEGER", true, 0, null, TableInfo.CREATED_FROM_ENTITY));
        _columnsEntries.put("feedTitle", new TableInfo.Column("feedTitle", "TEXT", false, 0, null, TableInfo.CREATED_FROM_ENTITY));
        _columnsEntries.put("lastSyncedAt", new TableInfo.Column("lastSyncedAt", "INTEGER", true, 0, null, TableInfo.CREATED_FROM_ENTITY));
        final HashSet<TableInfo.ForeignKey> _foreignKeysEntries = new HashSet<TableInfo.ForeignKey>(0);
        final HashSet<TableInfo.Index> _indicesEntries = new HashSet<TableInfo.Index>(3);
        _indicesEntries.add(new TableInfo.Index("index_entries_feedId", false, Arrays.asList("feedId"), Arrays.asList("ASC")));
        _indicesEntries.add(new TableInfo.Index("index_entries_fetchedAt", false, Arrays.asList("fetchedAt"), Arrays.asList("ASC")));
        _indicesEntries.add(new TableInfo.Index("index_entries_publishedAt", false, Arrays.asList("publishedAt"), Arrays.asList("ASC")));
        final TableInfo _infoEntries = new TableInfo("entries", _columnsEntries, _foreignKeysEntries, _indicesEntries);
        final TableInfo _existingEntries = TableInfo.read(db, "entries");
        if (!_infoEntries.equals(_existingEntries)) {
          return new RoomOpenHelper.ValidationResult(false, "entries(com.lionreader.data.db.entities.EntryEntity).\n"
                  + " Expected:\n" + _infoEntries + "\n"
                  + " Found:\n" + _existingEntries);
        }
        final HashMap<String, TableInfo.Column> _columnsEntryStates = new HashMap<String, TableInfo.Column>(7);
        _columnsEntryStates.put("entryId", new TableInfo.Column("entryId", "TEXT", true, 1, null, TableInfo.CREATED_FROM_ENTITY));
        _columnsEntryStates.put("read", new TableInfo.Column("read", "INTEGER", true, 0, null, TableInfo.CREATED_FROM_ENTITY));
        _columnsEntryStates.put("starred", new TableInfo.Column("starred", "INTEGER", true, 0, null, TableInfo.CREATED_FROM_ENTITY));
        _columnsEntryStates.put("readAt", new TableInfo.Column("readAt", "INTEGER", false, 0, null, TableInfo.CREATED_FROM_ENTITY));
        _columnsEntryStates.put("starredAt", new TableInfo.Column("starredAt", "INTEGER", false, 0, null, TableInfo.CREATED_FROM_ENTITY));
        _columnsEntryStates.put("pendingSync", new TableInfo.Column("pendingSync", "INTEGER", true, 0, null, TableInfo.CREATED_FROM_ENTITY));
        _columnsEntryStates.put("lastModifiedAt", new TableInfo.Column("lastModifiedAt", "INTEGER", true, 0, null, TableInfo.CREATED_FROM_ENTITY));
        final HashSet<TableInfo.ForeignKey> _foreignKeysEntryStates = new HashSet<TableInfo.ForeignKey>(1);
        _foreignKeysEntryStates.add(new TableInfo.ForeignKey("entries", "CASCADE", "NO ACTION", Arrays.asList("entryId"), Arrays.asList("id")));
        final HashSet<TableInfo.Index> _indicesEntryStates = new HashSet<TableInfo.Index>(2);
        _indicesEntryStates.add(new TableInfo.Index("index_entry_states_entryId", false, Arrays.asList("entryId"), Arrays.asList("ASC")));
        _indicesEntryStates.add(new TableInfo.Index("index_entry_states_pendingSync", false, Arrays.asList("pendingSync"), Arrays.asList("ASC")));
        final TableInfo _infoEntryStates = new TableInfo("entry_states", _columnsEntryStates, _foreignKeysEntryStates, _indicesEntryStates);
        final TableInfo _existingEntryStates = TableInfo.read(db, "entry_states");
        if (!_infoEntryStates.equals(_existingEntryStates)) {
          return new RoomOpenHelper.ValidationResult(false, "entry_states(com.lionreader.data.db.entities.EntryStateEntity).\n"
                  + " Expected:\n" + _infoEntryStates + "\n"
                  + " Found:\n" + _existingEntryStates);
        }
        final HashMap<String, TableInfo.Column> _columnsTags = new HashMap<String, TableInfo.Column>(5);
        _columnsTags.put("id", new TableInfo.Column("id", "TEXT", true, 1, null, TableInfo.CREATED_FROM_ENTITY));
        _columnsTags.put("name", new TableInfo.Column("name", "TEXT", true, 0, null, TableInfo.CREATED_FROM_ENTITY));
        _columnsTags.put("color", new TableInfo.Column("color", "TEXT", false, 0, null, TableInfo.CREATED_FROM_ENTITY));
        _columnsTags.put("feedCount", new TableInfo.Column("feedCount", "INTEGER", true, 0, null, TableInfo.CREATED_FROM_ENTITY));
        _columnsTags.put("unreadCount", new TableInfo.Column("unreadCount", "INTEGER", true, 0, null, TableInfo.CREATED_FROM_ENTITY));
        final HashSet<TableInfo.ForeignKey> _foreignKeysTags = new HashSet<TableInfo.ForeignKey>(0);
        final HashSet<TableInfo.Index> _indicesTags = new HashSet<TableInfo.Index>(0);
        final TableInfo _infoTags = new TableInfo("tags", _columnsTags, _foreignKeysTags, _indicesTags);
        final TableInfo _existingTags = TableInfo.read(db, "tags");
        if (!_infoTags.equals(_existingTags)) {
          return new RoomOpenHelper.ValidationResult(false, "tags(com.lionreader.data.db.entities.TagEntity).\n"
                  + " Expected:\n" + _infoTags + "\n"
                  + " Found:\n" + _existingTags);
        }
        final HashMap<String, TableInfo.Column> _columnsSubscriptionTags = new HashMap<String, TableInfo.Column>(2);
        _columnsSubscriptionTags.put("subscriptionId", new TableInfo.Column("subscriptionId", "TEXT", true, 1, null, TableInfo.CREATED_FROM_ENTITY));
        _columnsSubscriptionTags.put("tagId", new TableInfo.Column("tagId", "TEXT", true, 2, null, TableInfo.CREATED_FROM_ENTITY));
        final HashSet<TableInfo.ForeignKey> _foreignKeysSubscriptionTags = new HashSet<TableInfo.ForeignKey>(2);
        _foreignKeysSubscriptionTags.add(new TableInfo.ForeignKey("subscriptions", "CASCADE", "NO ACTION", Arrays.asList("subscriptionId"), Arrays.asList("id")));
        _foreignKeysSubscriptionTags.add(new TableInfo.ForeignKey("tags", "CASCADE", "NO ACTION", Arrays.asList("tagId"), Arrays.asList("id")));
        final HashSet<TableInfo.Index> _indicesSubscriptionTags = new HashSet<TableInfo.Index>(2);
        _indicesSubscriptionTags.add(new TableInfo.Index("index_subscription_tags_subscriptionId", false, Arrays.asList("subscriptionId"), Arrays.asList("ASC")));
        _indicesSubscriptionTags.add(new TableInfo.Index("index_subscription_tags_tagId", false, Arrays.asList("tagId"), Arrays.asList("ASC")));
        final TableInfo _infoSubscriptionTags = new TableInfo("subscription_tags", _columnsSubscriptionTags, _foreignKeysSubscriptionTags, _indicesSubscriptionTags);
        final TableInfo _existingSubscriptionTags = TableInfo.read(db, "subscription_tags");
        if (!_infoSubscriptionTags.equals(_existingSubscriptionTags)) {
          return new RoomOpenHelper.ValidationResult(false, "subscription_tags(com.lionreader.data.db.entities.SubscriptionTagEntity).\n"
                  + " Expected:\n" + _infoSubscriptionTags + "\n"
                  + " Found:\n" + _existingSubscriptionTags);
        }
        final HashMap<String, TableInfo.Column> _columnsPendingActions = new HashMap<String, TableInfo.Column>(5);
        _columnsPendingActions.put("id", new TableInfo.Column("id", "INTEGER", true, 1, null, TableInfo.CREATED_FROM_ENTITY));
        _columnsPendingActions.put("type", new TableInfo.Column("type", "TEXT", true, 0, null, TableInfo.CREATED_FROM_ENTITY));
        _columnsPendingActions.put("entryId", new TableInfo.Column("entryId", "TEXT", true, 0, null, TableInfo.CREATED_FROM_ENTITY));
        _columnsPendingActions.put("createdAt", new TableInfo.Column("createdAt", "INTEGER", true, 0, null, TableInfo.CREATED_FROM_ENTITY));
        _columnsPendingActions.put("retryCount", new TableInfo.Column("retryCount", "INTEGER", true, 0, null, TableInfo.CREATED_FROM_ENTITY));
        final HashSet<TableInfo.ForeignKey> _foreignKeysPendingActions = new HashSet<TableInfo.ForeignKey>(1);
        _foreignKeysPendingActions.add(new TableInfo.ForeignKey("entries", "CASCADE", "NO ACTION", Arrays.asList("entryId"), Arrays.asList("id")));
        final HashSet<TableInfo.Index> _indicesPendingActions = new HashSet<TableInfo.Index>(2);
        _indicesPendingActions.add(new TableInfo.Index("index_pending_actions_entryId", false, Arrays.asList("entryId"), Arrays.asList("ASC")));
        _indicesPendingActions.add(new TableInfo.Index("index_pending_actions_createdAt", false, Arrays.asList("createdAt"), Arrays.asList("ASC")));
        final TableInfo _infoPendingActions = new TableInfo("pending_actions", _columnsPendingActions, _foreignKeysPendingActions, _indicesPendingActions);
        final TableInfo _existingPendingActions = TableInfo.read(db, "pending_actions");
        if (!_infoPendingActions.equals(_existingPendingActions)) {
          return new RoomOpenHelper.ValidationResult(false, "pending_actions(com.lionreader.data.db.entities.PendingActionEntity).\n"
                  + " Expected:\n" + _infoPendingActions + "\n"
                  + " Found:\n" + _existingPendingActions);
        }
        return new RoomOpenHelper.ValidationResult(true, null);
      }
    }, "841f08db11fdc4e64a292f5ebb0db325", "afcd037964502c63c9eb00a4d6849b09");
    final SupportSQLiteOpenHelper.Configuration _sqliteConfig = SupportSQLiteOpenHelper.Configuration.builder(config.context).name(config.name).callback(_openCallback).build();
    final SupportSQLiteOpenHelper _helper = config.sqliteOpenHelperFactory.create(_sqliteConfig);
    return _helper;
  }

  @Override
  @NonNull
  protected InvalidationTracker createInvalidationTracker() {
    final HashMap<String, String> _shadowTablesMap = new HashMap<String, String>(0);
    final HashMap<String, Set<String>> _viewTables = new HashMap<String, Set<String>>(0);
    return new InvalidationTracker(this, _shadowTablesMap, _viewTables, "sessions","feeds","subscriptions","entries","entry_states","tags","subscription_tags","pending_actions");
  }

  @Override
  public void clearAllTables() {
    super.assertNotMainThread();
    final SupportSQLiteDatabase _db = super.getOpenHelper().getWritableDatabase();
    final boolean _supportsDeferForeignKeys = android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.LOLLIPOP;
    try {
      if (!_supportsDeferForeignKeys) {
        _db.execSQL("PRAGMA foreign_keys = FALSE");
      }
      super.beginTransaction();
      if (_supportsDeferForeignKeys) {
        _db.execSQL("PRAGMA defer_foreign_keys = TRUE");
      }
      _db.execSQL("DELETE FROM `sessions`");
      _db.execSQL("DELETE FROM `feeds`");
      _db.execSQL("DELETE FROM `subscriptions`");
      _db.execSQL("DELETE FROM `entries`");
      _db.execSQL("DELETE FROM `entry_states`");
      _db.execSQL("DELETE FROM `tags`");
      _db.execSQL("DELETE FROM `subscription_tags`");
      _db.execSQL("DELETE FROM `pending_actions`");
      super.setTransactionSuccessful();
    } finally {
      super.endTransaction();
      if (!_supportsDeferForeignKeys) {
        _db.execSQL("PRAGMA foreign_keys = TRUE");
      }
      _db.query("PRAGMA wal_checkpoint(FULL)").close();
      if (!_db.inTransaction()) {
        _db.execSQL("VACUUM");
      }
    }
  }

  @Override
  @NonNull
  protected Map<Class<?>, List<Class<?>>> getRequiredTypeConverters() {
    final HashMap<Class<?>, List<Class<?>>> _typeConvertersMap = new HashMap<Class<?>, List<Class<?>>>();
    _typeConvertersMap.put(EntryDao.class, EntryDao_Impl.getRequiredConverters());
    _typeConvertersMap.put(EntryStateDao.class, EntryStateDao_Impl.getRequiredConverters());
    _typeConvertersMap.put(PendingActionDao.class, PendingActionDao_Impl.getRequiredConverters());
    _typeConvertersMap.put(SubscriptionDao.class, SubscriptionDao_Impl.getRequiredConverters());
    _typeConvertersMap.put(TagDao.class, TagDao_Impl.getRequiredConverters());
    return _typeConvertersMap;
  }

  @Override
  @NonNull
  public Set<Class<? extends AutoMigrationSpec>> getRequiredAutoMigrationSpecs() {
    final HashSet<Class<? extends AutoMigrationSpec>> _autoMigrationSpecsSet = new HashSet<Class<? extends AutoMigrationSpec>>();
    return _autoMigrationSpecsSet;
  }

  @Override
  @NonNull
  public List<Migration> getAutoMigrations(
      @NonNull final Map<Class<? extends AutoMigrationSpec>, AutoMigrationSpec> autoMigrationSpecs) {
    final List<Migration> _autoMigrations = new ArrayList<Migration>();
    return _autoMigrations;
  }

  @Override
  public EntryDao entryDao() {
    if (_entryDao != null) {
      return _entryDao;
    } else {
      synchronized(this) {
        if(_entryDao == null) {
          _entryDao = new EntryDao_Impl(this);
        }
        return _entryDao;
      }
    }
  }

  @Override
  public EntryStateDao entryStateDao() {
    if (_entryStateDao != null) {
      return _entryStateDao;
    } else {
      synchronized(this) {
        if(_entryStateDao == null) {
          _entryStateDao = new EntryStateDao_Impl(this);
        }
        return _entryStateDao;
      }
    }
  }

  @Override
  public PendingActionDao pendingActionDao() {
    if (_pendingActionDao != null) {
      return _pendingActionDao;
    } else {
      synchronized(this) {
        if(_pendingActionDao == null) {
          _pendingActionDao = new PendingActionDao_Impl(this);
        }
        return _pendingActionDao;
      }
    }
  }

  @Override
  public SubscriptionDao subscriptionDao() {
    if (_subscriptionDao != null) {
      return _subscriptionDao;
    } else {
      synchronized(this) {
        if(_subscriptionDao == null) {
          _subscriptionDao = new SubscriptionDao_Impl(this);
        }
        return _subscriptionDao;
      }
    }
  }

  @Override
  public TagDao tagDao() {
    if (_tagDao != null) {
      return _tagDao;
    } else {
      synchronized(this) {
        if(_tagDao == null) {
          _tagDao = new TagDao_Impl(this);
        }
        return _tagDao;
      }
    }
  }
}
