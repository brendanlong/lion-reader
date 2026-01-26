package com.lionreader.data.db.dao;

import android.database.Cursor;
import android.os.CancellationSignal;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.room.CoroutinesRoom;
import androidx.room.EntityInsertionAdapter;
import androidx.room.RoomDatabase;
import androidx.room.RoomSQLiteQuery;
import androidx.room.SharedSQLiteStatement;
import androidx.room.util.CursorUtil;
import androidx.room.util.DBUtil;
import androidx.room.util.StringUtil;
import androidx.sqlite.db.SupportSQLiteStatement;
import com.lionreader.data.db.entities.FeedEntity;
import com.lionreader.data.db.entities.SubscriptionEntity;
import com.lionreader.data.db.relations.SubscriptionWithFeed;
import java.lang.Class;
import java.lang.Exception;
import java.lang.Integer;
import java.lang.Object;
import java.lang.Override;
import java.lang.String;
import java.lang.StringBuilder;
import java.lang.SuppressWarnings;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.Callable;
import javax.annotation.processing.Generated;
import kotlin.Unit;
import kotlin.coroutines.Continuation;
import kotlinx.coroutines.flow.Flow;

@Generated("androidx.room.RoomProcessor")
@SuppressWarnings({"unchecked", "deprecation"})
public final class SubscriptionDao_Impl implements SubscriptionDao {
  private final RoomDatabase __db;

  private final EntityInsertionAdapter<SubscriptionEntity> __insertionAdapterOfSubscriptionEntity;

  private final EntityInsertionAdapter<FeedEntity> __insertionAdapterOfFeedEntity;

  private final SharedSQLiteStatement __preparedStmtOfUpdateUnreadCount;

  private final SharedSQLiteStatement __preparedStmtOfDeleteAll;

  private final SharedSQLiteStatement __preparedStmtOfDeleteAllFeeds;

  public SubscriptionDao_Impl(@NonNull final RoomDatabase __db) {
    this.__db = __db;
    this.__insertionAdapterOfSubscriptionEntity = new EntityInsertionAdapter<SubscriptionEntity>(__db) {
      @Override
      @NonNull
      protected String createQuery() {
        return "INSERT OR REPLACE INTO `subscriptions` (`id`,`feedId`,`customTitle`,`subscribedAt`,`unreadCount`,`lastSyncedAt`) VALUES (?,?,?,?,?,?)";
      }

      @Override
      protected void bind(@NonNull final SupportSQLiteStatement statement,
          @NonNull final SubscriptionEntity entity) {
        statement.bindString(1, entity.getId());
        statement.bindString(2, entity.getFeedId());
        if (entity.getCustomTitle() == null) {
          statement.bindNull(3);
        } else {
          statement.bindString(3, entity.getCustomTitle());
        }
        statement.bindLong(4, entity.getSubscribedAt());
        statement.bindLong(5, entity.getUnreadCount());
        statement.bindLong(6, entity.getLastSyncedAt());
      }
    };
    this.__insertionAdapterOfFeedEntity = new EntityInsertionAdapter<FeedEntity>(__db) {
      @Override
      @NonNull
      protected String createQuery() {
        return "INSERT OR REPLACE INTO `feeds` (`id`,`type`,`url`,`title`,`description`,`siteUrl`,`lastSyncedAt`) VALUES (?,?,?,?,?,?,?)";
      }

      @Override
      protected void bind(@NonNull final SupportSQLiteStatement statement,
          @NonNull final FeedEntity entity) {
        statement.bindString(1, entity.getId());
        statement.bindString(2, entity.getType());
        if (entity.getUrl() == null) {
          statement.bindNull(3);
        } else {
          statement.bindString(3, entity.getUrl());
        }
        if (entity.getTitle() == null) {
          statement.bindNull(4);
        } else {
          statement.bindString(4, entity.getTitle());
        }
        if (entity.getDescription() == null) {
          statement.bindNull(5);
        } else {
          statement.bindString(5, entity.getDescription());
        }
        if (entity.getSiteUrl() == null) {
          statement.bindNull(6);
        } else {
          statement.bindString(6, entity.getSiteUrl());
        }
        statement.bindLong(7, entity.getLastSyncedAt());
      }
    };
    this.__preparedStmtOfUpdateUnreadCount = new SharedSQLiteStatement(__db) {
      @Override
      @NonNull
      public String createQuery() {
        final String _query = "UPDATE subscriptions SET unreadCount = ? WHERE id = ?";
        return _query;
      }
    };
    this.__preparedStmtOfDeleteAll = new SharedSQLiteStatement(__db) {
      @Override
      @NonNull
      public String createQuery() {
        final String _query = "DELETE FROM subscriptions";
        return _query;
      }
    };
    this.__preparedStmtOfDeleteAllFeeds = new SharedSQLiteStatement(__db) {
      @Override
      @NonNull
      public String createQuery() {
        final String _query = "DELETE FROM feeds";
        return _query;
      }
    };
  }

  @Override
  public Object insertAll(final List<SubscriptionEntity> subscriptions,
      final Continuation<? super Unit> $completion) {
    return CoroutinesRoom.execute(__db, true, new Callable<Unit>() {
      @Override
      @NonNull
      public Unit call() throws Exception {
        __db.beginTransaction();
        try {
          __insertionAdapterOfSubscriptionEntity.insert(subscriptions);
          __db.setTransactionSuccessful();
          return Unit.INSTANCE;
        } finally {
          __db.endTransaction();
        }
      }
    }, $completion);
  }

  @Override
  public Object insertFeeds(final List<FeedEntity> feeds,
      final Continuation<? super Unit> $completion) {
    return CoroutinesRoom.execute(__db, true, new Callable<Unit>() {
      @Override
      @NonNull
      public Unit call() throws Exception {
        __db.beginTransaction();
        try {
          __insertionAdapterOfFeedEntity.insert(feeds);
          __db.setTransactionSuccessful();
          return Unit.INSTANCE;
        } finally {
          __db.endTransaction();
        }
      }
    }, $completion);
  }

  @Override
  public Object updateUnreadCount(final String subscriptionId, final int unreadCount,
      final Continuation<? super Unit> $completion) {
    return CoroutinesRoom.execute(__db, true, new Callable<Unit>() {
      @Override
      @NonNull
      public Unit call() throws Exception {
        final SupportSQLiteStatement _stmt = __preparedStmtOfUpdateUnreadCount.acquire();
        int _argIndex = 1;
        _stmt.bindLong(_argIndex, unreadCount);
        _argIndex = 2;
        _stmt.bindString(_argIndex, subscriptionId);
        try {
          __db.beginTransaction();
          try {
            _stmt.executeUpdateDelete();
            __db.setTransactionSuccessful();
            return Unit.INSTANCE;
          } finally {
            __db.endTransaction();
          }
        } finally {
          __preparedStmtOfUpdateUnreadCount.release(_stmt);
        }
      }
    }, $completion);
  }

  @Override
  public Object deleteAll(final Continuation<? super Unit> $completion) {
    return CoroutinesRoom.execute(__db, true, new Callable<Unit>() {
      @Override
      @NonNull
      public Unit call() throws Exception {
        final SupportSQLiteStatement _stmt = __preparedStmtOfDeleteAll.acquire();
        try {
          __db.beginTransaction();
          try {
            _stmt.executeUpdateDelete();
            __db.setTransactionSuccessful();
            return Unit.INSTANCE;
          } finally {
            __db.endTransaction();
          }
        } finally {
          __preparedStmtOfDeleteAll.release(_stmt);
        }
      }
    }, $completion);
  }

  @Override
  public Object deleteAllFeeds(final Continuation<? super Unit> $completion) {
    return CoroutinesRoom.execute(__db, true, new Callable<Unit>() {
      @Override
      @NonNull
      public Unit call() throws Exception {
        final SupportSQLiteStatement _stmt = __preparedStmtOfDeleteAllFeeds.acquire();
        try {
          __db.beginTransaction();
          try {
            _stmt.executeUpdateDelete();
            __db.setTransactionSuccessful();
            return Unit.INSTANCE;
          } finally {
            __db.endTransaction();
          }
        } finally {
          __preparedStmtOfDeleteAllFeeds.release(_stmt);
        }
      }
    }, $completion);
  }

  @Override
  public Flow<List<SubscriptionWithFeed>> getAllWithFeeds() {
    final String _sql = "\n"
            + "        SELECT s.*,\n"
            + "               f.id AS feed_id,\n"
            + "               f.type AS feed_type,\n"
            + "               f.url AS feed_url,\n"
            + "               f.title AS feed_title,\n"
            + "               f.description AS feed_description,\n"
            + "               f.siteUrl AS feed_siteUrl,\n"
            + "               f.lastSyncedAt AS feed_lastSyncedAt\n"
            + "        FROM subscriptions s\n"
            + "        JOIN feeds f ON s.feedId = f.id\n"
            + "        ORDER BY COALESCE(s.customTitle, f.title) ASC\n"
            + "        ";
    final RoomSQLiteQuery _statement = RoomSQLiteQuery.acquire(_sql, 0);
    return CoroutinesRoom.createFlow(__db, false, new String[] {"subscriptions",
        "feeds"}, new Callable<List<SubscriptionWithFeed>>() {
      @Override
      @NonNull
      public List<SubscriptionWithFeed> call() throws Exception {
        final Cursor _cursor = DBUtil.query(__db, _statement, false, null);
        try {
          final int _cursorIndexOfId = CursorUtil.getColumnIndexOrThrow(_cursor, "id");
          final int _cursorIndexOfFeedId = CursorUtil.getColumnIndexOrThrow(_cursor, "feedId");
          final int _cursorIndexOfCustomTitle = CursorUtil.getColumnIndexOrThrow(_cursor, "customTitle");
          final int _cursorIndexOfSubscribedAt = CursorUtil.getColumnIndexOrThrow(_cursor, "subscribedAt");
          final int _cursorIndexOfUnreadCount = CursorUtil.getColumnIndexOrThrow(_cursor, "unreadCount");
          final int _cursorIndexOfLastSyncedAt = CursorUtil.getColumnIndexOrThrow(_cursor, "lastSyncedAt");
          final int _cursorIndexOfId_1 = CursorUtil.getColumnIndexOrThrow(_cursor, "feed_id");
          final int _cursorIndexOfType = CursorUtil.getColumnIndexOrThrow(_cursor, "feed_type");
          final int _cursorIndexOfUrl = CursorUtil.getColumnIndexOrThrow(_cursor, "feed_url");
          final int _cursorIndexOfTitle = CursorUtil.getColumnIndexOrThrow(_cursor, "feed_title");
          final int _cursorIndexOfDescription = CursorUtil.getColumnIndexOrThrow(_cursor, "feed_description");
          final int _cursorIndexOfSiteUrl = CursorUtil.getColumnIndexOrThrow(_cursor, "feed_siteUrl");
          final int _cursorIndexOfLastSyncedAt_1 = CursorUtil.getColumnIndexOrThrow(_cursor, "feed_lastSyncedAt");
          final List<SubscriptionWithFeed> _result = new ArrayList<SubscriptionWithFeed>(_cursor.getCount());
          while (_cursor.moveToNext()) {
            final SubscriptionWithFeed _item;
            final SubscriptionEntity _tmpSubscription;
            final String _tmpId;
            _tmpId = _cursor.getString(_cursorIndexOfId);
            final String _tmpFeedId;
            _tmpFeedId = _cursor.getString(_cursorIndexOfFeedId);
            final String _tmpCustomTitle;
            if (_cursor.isNull(_cursorIndexOfCustomTitle)) {
              _tmpCustomTitle = null;
            } else {
              _tmpCustomTitle = _cursor.getString(_cursorIndexOfCustomTitle);
            }
            final long _tmpSubscribedAt;
            _tmpSubscribedAt = _cursor.getLong(_cursorIndexOfSubscribedAt);
            final int _tmpUnreadCount;
            _tmpUnreadCount = _cursor.getInt(_cursorIndexOfUnreadCount);
            final long _tmpLastSyncedAt;
            _tmpLastSyncedAt = _cursor.getLong(_cursorIndexOfLastSyncedAt);
            _tmpSubscription = new SubscriptionEntity(_tmpId,_tmpFeedId,_tmpCustomTitle,_tmpSubscribedAt,_tmpUnreadCount,_tmpLastSyncedAt);
            final FeedEntity _tmpFeed;
            final String _tmpId_1;
            _tmpId_1 = _cursor.getString(_cursorIndexOfId_1);
            final String _tmpType;
            _tmpType = _cursor.getString(_cursorIndexOfType);
            final String _tmpUrl;
            if (_cursor.isNull(_cursorIndexOfUrl)) {
              _tmpUrl = null;
            } else {
              _tmpUrl = _cursor.getString(_cursorIndexOfUrl);
            }
            final String _tmpTitle;
            if (_cursor.isNull(_cursorIndexOfTitle)) {
              _tmpTitle = null;
            } else {
              _tmpTitle = _cursor.getString(_cursorIndexOfTitle);
            }
            final String _tmpDescription;
            if (_cursor.isNull(_cursorIndexOfDescription)) {
              _tmpDescription = null;
            } else {
              _tmpDescription = _cursor.getString(_cursorIndexOfDescription);
            }
            final String _tmpSiteUrl;
            if (_cursor.isNull(_cursorIndexOfSiteUrl)) {
              _tmpSiteUrl = null;
            } else {
              _tmpSiteUrl = _cursor.getString(_cursorIndexOfSiteUrl);
            }
            final long _tmpLastSyncedAt_1;
            _tmpLastSyncedAt_1 = _cursor.getLong(_cursorIndexOfLastSyncedAt_1);
            _tmpFeed = new FeedEntity(_tmpId_1,_tmpType,_tmpUrl,_tmpTitle,_tmpDescription,_tmpSiteUrl,_tmpLastSyncedAt_1);
            _item = new SubscriptionWithFeed(_tmpSubscription,_tmpFeed);
            _result.add(_item);
          }
          return _result;
        } finally {
          _cursor.close();
        }
      }

      @Override
      protected void finalize() {
        _statement.release();
      }
    });
  }

  @Override
  public Flow<SubscriptionWithFeed> getSubscriptionWithFeed(final String subscriptionId) {
    final String _sql = "\n"
            + "        SELECT s.*,\n"
            + "               f.id AS feed_id,\n"
            + "               f.type AS feed_type,\n"
            + "               f.url AS feed_url,\n"
            + "               f.title AS feed_title,\n"
            + "               f.description AS feed_description,\n"
            + "               f.siteUrl AS feed_siteUrl,\n"
            + "               f.lastSyncedAt AS feed_lastSyncedAt\n"
            + "        FROM subscriptions s\n"
            + "        JOIN feeds f ON s.feedId = f.id\n"
            + "        WHERE s.id = ?\n"
            + "        ";
    final RoomSQLiteQuery _statement = RoomSQLiteQuery.acquire(_sql, 1);
    int _argIndex = 1;
    _statement.bindString(_argIndex, subscriptionId);
    return CoroutinesRoom.createFlow(__db, false, new String[] {"subscriptions",
        "feeds"}, new Callable<SubscriptionWithFeed>() {
      @Override
      @Nullable
      public SubscriptionWithFeed call() throws Exception {
        final Cursor _cursor = DBUtil.query(__db, _statement, false, null);
        try {
          final int _cursorIndexOfId = CursorUtil.getColumnIndexOrThrow(_cursor, "id");
          final int _cursorIndexOfFeedId = CursorUtil.getColumnIndexOrThrow(_cursor, "feedId");
          final int _cursorIndexOfCustomTitle = CursorUtil.getColumnIndexOrThrow(_cursor, "customTitle");
          final int _cursorIndexOfSubscribedAt = CursorUtil.getColumnIndexOrThrow(_cursor, "subscribedAt");
          final int _cursorIndexOfUnreadCount = CursorUtil.getColumnIndexOrThrow(_cursor, "unreadCount");
          final int _cursorIndexOfLastSyncedAt = CursorUtil.getColumnIndexOrThrow(_cursor, "lastSyncedAt");
          final int _cursorIndexOfId_1 = CursorUtil.getColumnIndexOrThrow(_cursor, "feed_id");
          final int _cursorIndexOfType = CursorUtil.getColumnIndexOrThrow(_cursor, "feed_type");
          final int _cursorIndexOfUrl = CursorUtil.getColumnIndexOrThrow(_cursor, "feed_url");
          final int _cursorIndexOfTitle = CursorUtil.getColumnIndexOrThrow(_cursor, "feed_title");
          final int _cursorIndexOfDescription = CursorUtil.getColumnIndexOrThrow(_cursor, "feed_description");
          final int _cursorIndexOfSiteUrl = CursorUtil.getColumnIndexOrThrow(_cursor, "feed_siteUrl");
          final int _cursorIndexOfLastSyncedAt_1 = CursorUtil.getColumnIndexOrThrow(_cursor, "feed_lastSyncedAt");
          final SubscriptionWithFeed _result;
          if (_cursor.moveToFirst()) {
            final SubscriptionEntity _tmpSubscription;
            final String _tmpId;
            _tmpId = _cursor.getString(_cursorIndexOfId);
            final String _tmpFeedId;
            _tmpFeedId = _cursor.getString(_cursorIndexOfFeedId);
            final String _tmpCustomTitle;
            if (_cursor.isNull(_cursorIndexOfCustomTitle)) {
              _tmpCustomTitle = null;
            } else {
              _tmpCustomTitle = _cursor.getString(_cursorIndexOfCustomTitle);
            }
            final long _tmpSubscribedAt;
            _tmpSubscribedAt = _cursor.getLong(_cursorIndexOfSubscribedAt);
            final int _tmpUnreadCount;
            _tmpUnreadCount = _cursor.getInt(_cursorIndexOfUnreadCount);
            final long _tmpLastSyncedAt;
            _tmpLastSyncedAt = _cursor.getLong(_cursorIndexOfLastSyncedAt);
            _tmpSubscription = new SubscriptionEntity(_tmpId,_tmpFeedId,_tmpCustomTitle,_tmpSubscribedAt,_tmpUnreadCount,_tmpLastSyncedAt);
            final FeedEntity _tmpFeed;
            final String _tmpId_1;
            _tmpId_1 = _cursor.getString(_cursorIndexOfId_1);
            final String _tmpType;
            _tmpType = _cursor.getString(_cursorIndexOfType);
            final String _tmpUrl;
            if (_cursor.isNull(_cursorIndexOfUrl)) {
              _tmpUrl = null;
            } else {
              _tmpUrl = _cursor.getString(_cursorIndexOfUrl);
            }
            final String _tmpTitle;
            if (_cursor.isNull(_cursorIndexOfTitle)) {
              _tmpTitle = null;
            } else {
              _tmpTitle = _cursor.getString(_cursorIndexOfTitle);
            }
            final String _tmpDescription;
            if (_cursor.isNull(_cursorIndexOfDescription)) {
              _tmpDescription = null;
            } else {
              _tmpDescription = _cursor.getString(_cursorIndexOfDescription);
            }
            final String _tmpSiteUrl;
            if (_cursor.isNull(_cursorIndexOfSiteUrl)) {
              _tmpSiteUrl = null;
            } else {
              _tmpSiteUrl = _cursor.getString(_cursorIndexOfSiteUrl);
            }
            final long _tmpLastSyncedAt_1;
            _tmpLastSyncedAt_1 = _cursor.getLong(_cursorIndexOfLastSyncedAt_1);
            _tmpFeed = new FeedEntity(_tmpId_1,_tmpType,_tmpUrl,_tmpTitle,_tmpDescription,_tmpSiteUrl,_tmpLastSyncedAt_1);
            _result = new SubscriptionWithFeed(_tmpSubscription,_tmpFeed);
          } else {
            _result = null;
          }
          return _result;
        } finally {
          _cursor.close();
        }
      }

      @Override
      protected void finalize() {
        _statement.release();
      }
    });
  }

  @Override
  public Object getByFeedId(final String feedId,
      final Continuation<? super SubscriptionEntity> $completion) {
    final String _sql = "SELECT * FROM subscriptions WHERE feedId = ?";
    final RoomSQLiteQuery _statement = RoomSQLiteQuery.acquire(_sql, 1);
    int _argIndex = 1;
    _statement.bindString(_argIndex, feedId);
    final CancellationSignal _cancellationSignal = DBUtil.createCancellationSignal();
    return CoroutinesRoom.execute(__db, false, _cancellationSignal, new Callable<SubscriptionEntity>() {
      @Override
      @Nullable
      public SubscriptionEntity call() throws Exception {
        final Cursor _cursor = DBUtil.query(__db, _statement, false, null);
        try {
          final int _cursorIndexOfId = CursorUtil.getColumnIndexOrThrow(_cursor, "id");
          final int _cursorIndexOfFeedId = CursorUtil.getColumnIndexOrThrow(_cursor, "feedId");
          final int _cursorIndexOfCustomTitle = CursorUtil.getColumnIndexOrThrow(_cursor, "customTitle");
          final int _cursorIndexOfSubscribedAt = CursorUtil.getColumnIndexOrThrow(_cursor, "subscribedAt");
          final int _cursorIndexOfUnreadCount = CursorUtil.getColumnIndexOrThrow(_cursor, "unreadCount");
          final int _cursorIndexOfLastSyncedAt = CursorUtil.getColumnIndexOrThrow(_cursor, "lastSyncedAt");
          final SubscriptionEntity _result;
          if (_cursor.moveToFirst()) {
            final String _tmpId;
            _tmpId = _cursor.getString(_cursorIndexOfId);
            final String _tmpFeedId;
            _tmpFeedId = _cursor.getString(_cursorIndexOfFeedId);
            final String _tmpCustomTitle;
            if (_cursor.isNull(_cursorIndexOfCustomTitle)) {
              _tmpCustomTitle = null;
            } else {
              _tmpCustomTitle = _cursor.getString(_cursorIndexOfCustomTitle);
            }
            final long _tmpSubscribedAt;
            _tmpSubscribedAt = _cursor.getLong(_cursorIndexOfSubscribedAt);
            final int _tmpUnreadCount;
            _tmpUnreadCount = _cursor.getInt(_cursorIndexOfUnreadCount);
            final long _tmpLastSyncedAt;
            _tmpLastSyncedAt = _cursor.getLong(_cursorIndexOfLastSyncedAt);
            _result = new SubscriptionEntity(_tmpId,_tmpFeedId,_tmpCustomTitle,_tmpSubscribedAt,_tmpUnreadCount,_tmpLastSyncedAt);
          } else {
            _result = null;
          }
          return _result;
        } finally {
          _cursor.close();
          _statement.release();
        }
      }
    }, $completion);
  }

  @Override
  public Object getSubscriptionWithFeedByFeedId(final String feedId,
      final Continuation<? super SubscriptionWithFeed> $completion) {
    final String _sql = "\n"
            + "        SELECT s.*,\n"
            + "               f.id AS feed_id,\n"
            + "               f.type AS feed_type,\n"
            + "               f.url AS feed_url,\n"
            + "               f.title AS feed_title,\n"
            + "               f.description AS feed_description,\n"
            + "               f.siteUrl AS feed_siteUrl,\n"
            + "               f.lastSyncedAt AS feed_lastSyncedAt\n"
            + "        FROM subscriptions s\n"
            + "        JOIN feeds f ON s.feedId = f.id\n"
            + "        WHERE s.feedId = ?\n"
            + "        ";
    final RoomSQLiteQuery _statement = RoomSQLiteQuery.acquire(_sql, 1);
    int _argIndex = 1;
    _statement.bindString(_argIndex, feedId);
    final CancellationSignal _cancellationSignal = DBUtil.createCancellationSignal();
    return CoroutinesRoom.execute(__db, false, _cancellationSignal, new Callable<SubscriptionWithFeed>() {
      @Override
      @Nullable
      public SubscriptionWithFeed call() throws Exception {
        final Cursor _cursor = DBUtil.query(__db, _statement, false, null);
        try {
          final int _cursorIndexOfId = CursorUtil.getColumnIndexOrThrow(_cursor, "id");
          final int _cursorIndexOfFeedId = CursorUtil.getColumnIndexOrThrow(_cursor, "feedId");
          final int _cursorIndexOfCustomTitle = CursorUtil.getColumnIndexOrThrow(_cursor, "customTitle");
          final int _cursorIndexOfSubscribedAt = CursorUtil.getColumnIndexOrThrow(_cursor, "subscribedAt");
          final int _cursorIndexOfUnreadCount = CursorUtil.getColumnIndexOrThrow(_cursor, "unreadCount");
          final int _cursorIndexOfLastSyncedAt = CursorUtil.getColumnIndexOrThrow(_cursor, "lastSyncedAt");
          final int _cursorIndexOfId_1 = CursorUtil.getColumnIndexOrThrow(_cursor, "feed_id");
          final int _cursorIndexOfType = CursorUtil.getColumnIndexOrThrow(_cursor, "feed_type");
          final int _cursorIndexOfUrl = CursorUtil.getColumnIndexOrThrow(_cursor, "feed_url");
          final int _cursorIndexOfTitle = CursorUtil.getColumnIndexOrThrow(_cursor, "feed_title");
          final int _cursorIndexOfDescription = CursorUtil.getColumnIndexOrThrow(_cursor, "feed_description");
          final int _cursorIndexOfSiteUrl = CursorUtil.getColumnIndexOrThrow(_cursor, "feed_siteUrl");
          final int _cursorIndexOfLastSyncedAt_1 = CursorUtil.getColumnIndexOrThrow(_cursor, "feed_lastSyncedAt");
          final SubscriptionWithFeed _result;
          if (_cursor.moveToFirst()) {
            final SubscriptionEntity _tmpSubscription;
            final String _tmpId;
            _tmpId = _cursor.getString(_cursorIndexOfId);
            final String _tmpFeedId;
            _tmpFeedId = _cursor.getString(_cursorIndexOfFeedId);
            final String _tmpCustomTitle;
            if (_cursor.isNull(_cursorIndexOfCustomTitle)) {
              _tmpCustomTitle = null;
            } else {
              _tmpCustomTitle = _cursor.getString(_cursorIndexOfCustomTitle);
            }
            final long _tmpSubscribedAt;
            _tmpSubscribedAt = _cursor.getLong(_cursorIndexOfSubscribedAt);
            final int _tmpUnreadCount;
            _tmpUnreadCount = _cursor.getInt(_cursorIndexOfUnreadCount);
            final long _tmpLastSyncedAt;
            _tmpLastSyncedAt = _cursor.getLong(_cursorIndexOfLastSyncedAt);
            _tmpSubscription = new SubscriptionEntity(_tmpId,_tmpFeedId,_tmpCustomTitle,_tmpSubscribedAt,_tmpUnreadCount,_tmpLastSyncedAt);
            final FeedEntity _tmpFeed;
            final String _tmpId_1;
            _tmpId_1 = _cursor.getString(_cursorIndexOfId_1);
            final String _tmpType;
            _tmpType = _cursor.getString(_cursorIndexOfType);
            final String _tmpUrl;
            if (_cursor.isNull(_cursorIndexOfUrl)) {
              _tmpUrl = null;
            } else {
              _tmpUrl = _cursor.getString(_cursorIndexOfUrl);
            }
            final String _tmpTitle;
            if (_cursor.isNull(_cursorIndexOfTitle)) {
              _tmpTitle = null;
            } else {
              _tmpTitle = _cursor.getString(_cursorIndexOfTitle);
            }
            final String _tmpDescription;
            if (_cursor.isNull(_cursorIndexOfDescription)) {
              _tmpDescription = null;
            } else {
              _tmpDescription = _cursor.getString(_cursorIndexOfDescription);
            }
            final String _tmpSiteUrl;
            if (_cursor.isNull(_cursorIndexOfSiteUrl)) {
              _tmpSiteUrl = null;
            } else {
              _tmpSiteUrl = _cursor.getString(_cursorIndexOfSiteUrl);
            }
            final long _tmpLastSyncedAt_1;
            _tmpLastSyncedAt_1 = _cursor.getLong(_cursorIndexOfLastSyncedAt_1);
            _tmpFeed = new FeedEntity(_tmpId_1,_tmpType,_tmpUrl,_tmpTitle,_tmpDescription,_tmpSiteUrl,_tmpLastSyncedAt_1);
            _result = new SubscriptionWithFeed(_tmpSubscription,_tmpFeed);
          } else {
            _result = null;
          }
          return _result;
        } finally {
          _cursor.close();
          _statement.release();
        }
      }
    }, $completion);
  }

  @Override
  public Flow<Integer> getTotalUnreadCount() {
    final String _sql = "SELECT COALESCE(SUM(unreadCount), 0) FROM subscriptions";
    final RoomSQLiteQuery _statement = RoomSQLiteQuery.acquire(_sql, 0);
    return CoroutinesRoom.createFlow(__db, false, new String[] {"subscriptions"}, new Callable<Integer>() {
      @Override
      @NonNull
      public Integer call() throws Exception {
        final Cursor _cursor = DBUtil.query(__db, _statement, false, null);
        try {
          final Integer _result;
          if (_cursor.moveToFirst()) {
            final int _tmp;
            _tmp = _cursor.getInt(0);
            _result = _tmp;
          } else {
            _result = 0;
          }
          return _result;
        } finally {
          _cursor.close();
        }
      }

      @Override
      protected void finalize() {
        _statement.release();
      }
    });
  }

  @Override
  public Flow<Integer> getUncategorizedUnreadCount() {
    final String _sql = "\n"
            + "        SELECT COALESCE(SUM(s.unreadCount), 0) FROM subscriptions s\n"
            + "        WHERE s.id NOT IN (\n"
            + "            SELECT st.subscriptionId FROM subscription_tags st\n"
            + "        )\n"
            + "        ";
    final RoomSQLiteQuery _statement = RoomSQLiteQuery.acquire(_sql, 0);
    return CoroutinesRoom.createFlow(__db, false, new String[] {"subscriptions",
        "subscription_tags"}, new Callable<Integer>() {
      @Override
      @NonNull
      public Integer call() throws Exception {
        final Cursor _cursor = DBUtil.query(__db, _statement, false, null);
        try {
          final Integer _result;
          if (_cursor.moveToFirst()) {
            final int _tmp;
            _tmp = _cursor.getInt(0);
            _result = _tmp;
          } else {
            _result = 0;
          }
          return _result;
        } finally {
          _cursor.close();
        }
      }

      @Override
      protected void finalize() {
        _statement.release();
      }
    });
  }

  @Override
  public Flow<List<SubscriptionWithFeed>> getUncategorizedWithFeeds() {
    final String _sql = "\n"
            + "        SELECT s.*,\n"
            + "               f.id AS feed_id,\n"
            + "               f.type AS feed_type,\n"
            + "               f.url AS feed_url,\n"
            + "               f.title AS feed_title,\n"
            + "               f.description AS feed_description,\n"
            + "               f.siteUrl AS feed_siteUrl,\n"
            + "               f.lastSyncedAt AS feed_lastSyncedAt\n"
            + "        FROM subscriptions s\n"
            + "        JOIN feeds f ON s.feedId = f.id\n"
            + "        WHERE s.id NOT IN (\n"
            + "            SELECT st.subscriptionId FROM subscription_tags st\n"
            + "        )\n"
            + "        ORDER BY COALESCE(s.customTitle, f.title) ASC\n"
            + "        ";
    final RoomSQLiteQuery _statement = RoomSQLiteQuery.acquire(_sql, 0);
    return CoroutinesRoom.createFlow(__db, false, new String[] {"subscriptions", "feeds",
        "subscription_tags"}, new Callable<List<SubscriptionWithFeed>>() {
      @Override
      @NonNull
      public List<SubscriptionWithFeed> call() throws Exception {
        final Cursor _cursor = DBUtil.query(__db, _statement, false, null);
        try {
          final int _cursorIndexOfId = CursorUtil.getColumnIndexOrThrow(_cursor, "id");
          final int _cursorIndexOfFeedId = CursorUtil.getColumnIndexOrThrow(_cursor, "feedId");
          final int _cursorIndexOfCustomTitle = CursorUtil.getColumnIndexOrThrow(_cursor, "customTitle");
          final int _cursorIndexOfSubscribedAt = CursorUtil.getColumnIndexOrThrow(_cursor, "subscribedAt");
          final int _cursorIndexOfUnreadCount = CursorUtil.getColumnIndexOrThrow(_cursor, "unreadCount");
          final int _cursorIndexOfLastSyncedAt = CursorUtil.getColumnIndexOrThrow(_cursor, "lastSyncedAt");
          final int _cursorIndexOfId_1 = CursorUtil.getColumnIndexOrThrow(_cursor, "feed_id");
          final int _cursorIndexOfType = CursorUtil.getColumnIndexOrThrow(_cursor, "feed_type");
          final int _cursorIndexOfUrl = CursorUtil.getColumnIndexOrThrow(_cursor, "feed_url");
          final int _cursorIndexOfTitle = CursorUtil.getColumnIndexOrThrow(_cursor, "feed_title");
          final int _cursorIndexOfDescription = CursorUtil.getColumnIndexOrThrow(_cursor, "feed_description");
          final int _cursorIndexOfSiteUrl = CursorUtil.getColumnIndexOrThrow(_cursor, "feed_siteUrl");
          final int _cursorIndexOfLastSyncedAt_1 = CursorUtil.getColumnIndexOrThrow(_cursor, "feed_lastSyncedAt");
          final List<SubscriptionWithFeed> _result = new ArrayList<SubscriptionWithFeed>(_cursor.getCount());
          while (_cursor.moveToNext()) {
            final SubscriptionWithFeed _item;
            final SubscriptionEntity _tmpSubscription;
            final String _tmpId;
            _tmpId = _cursor.getString(_cursorIndexOfId);
            final String _tmpFeedId;
            _tmpFeedId = _cursor.getString(_cursorIndexOfFeedId);
            final String _tmpCustomTitle;
            if (_cursor.isNull(_cursorIndexOfCustomTitle)) {
              _tmpCustomTitle = null;
            } else {
              _tmpCustomTitle = _cursor.getString(_cursorIndexOfCustomTitle);
            }
            final long _tmpSubscribedAt;
            _tmpSubscribedAt = _cursor.getLong(_cursorIndexOfSubscribedAt);
            final int _tmpUnreadCount;
            _tmpUnreadCount = _cursor.getInt(_cursorIndexOfUnreadCount);
            final long _tmpLastSyncedAt;
            _tmpLastSyncedAt = _cursor.getLong(_cursorIndexOfLastSyncedAt);
            _tmpSubscription = new SubscriptionEntity(_tmpId,_tmpFeedId,_tmpCustomTitle,_tmpSubscribedAt,_tmpUnreadCount,_tmpLastSyncedAt);
            final FeedEntity _tmpFeed;
            final String _tmpId_1;
            _tmpId_1 = _cursor.getString(_cursorIndexOfId_1);
            final String _tmpType;
            _tmpType = _cursor.getString(_cursorIndexOfType);
            final String _tmpUrl;
            if (_cursor.isNull(_cursorIndexOfUrl)) {
              _tmpUrl = null;
            } else {
              _tmpUrl = _cursor.getString(_cursorIndexOfUrl);
            }
            final String _tmpTitle;
            if (_cursor.isNull(_cursorIndexOfTitle)) {
              _tmpTitle = null;
            } else {
              _tmpTitle = _cursor.getString(_cursorIndexOfTitle);
            }
            final String _tmpDescription;
            if (_cursor.isNull(_cursorIndexOfDescription)) {
              _tmpDescription = null;
            } else {
              _tmpDescription = _cursor.getString(_cursorIndexOfDescription);
            }
            final String _tmpSiteUrl;
            if (_cursor.isNull(_cursorIndexOfSiteUrl)) {
              _tmpSiteUrl = null;
            } else {
              _tmpSiteUrl = _cursor.getString(_cursorIndexOfSiteUrl);
            }
            final long _tmpLastSyncedAt_1;
            _tmpLastSyncedAt_1 = _cursor.getLong(_cursorIndexOfLastSyncedAt_1);
            _tmpFeed = new FeedEntity(_tmpId_1,_tmpType,_tmpUrl,_tmpTitle,_tmpDescription,_tmpSiteUrl,_tmpLastSyncedAt_1);
            _item = new SubscriptionWithFeed(_tmpSubscription,_tmpFeed);
            _result.add(_item);
          }
          return _result;
        } finally {
          _cursor.close();
        }
      }

      @Override
      protected void finalize() {
        _statement.release();
      }
    });
  }

  @Override
  public Object deleteByIds(final List<String> ids, final Continuation<? super Unit> $completion) {
    return CoroutinesRoom.execute(__db, true, new Callable<Unit>() {
      @Override
      @NonNull
      public Unit call() throws Exception {
        final StringBuilder _stringBuilder = StringUtil.newStringBuilder();
        _stringBuilder.append("DELETE FROM subscriptions WHERE id IN (");
        final int _inputSize = ids.size();
        StringUtil.appendPlaceholders(_stringBuilder, _inputSize);
        _stringBuilder.append(")");
        final String _sql = _stringBuilder.toString();
        final SupportSQLiteStatement _stmt = __db.compileStatement(_sql);
        int _argIndex = 1;
        for (String _item : ids) {
          _stmt.bindString(_argIndex, _item);
          _argIndex++;
        }
        __db.beginTransaction();
        try {
          _stmt.executeUpdateDelete();
          __db.setTransactionSuccessful();
          return Unit.INSTANCE;
        } finally {
          __db.endTransaction();
        }
      }
    }, $completion);
  }

  @NonNull
  public static List<Class<?>> getRequiredConverters() {
    return Collections.emptyList();
  }
}
