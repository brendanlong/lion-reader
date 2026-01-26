package com.lionreader.data.db.dao;

import android.database.Cursor;
import android.os.CancellationSignal;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.room.CoroutinesRoom;
import androidx.room.EntityDeletionOrUpdateAdapter;
import androidx.room.EntityInsertionAdapter;
import androidx.room.EntityUpsertionAdapter;
import androidx.room.RoomDatabase;
import androidx.room.RoomSQLiteQuery;
import androidx.room.SharedSQLiteStatement;
import androidx.room.util.CursorUtil;
import androidx.room.util.DBUtil;
import androidx.room.util.StringUtil;
import androidx.sqlite.db.SupportSQLiteStatement;
import com.lionreader.data.db.entities.EntryEntity;
import com.lionreader.data.db.relations.EntryWithState;
import java.lang.Boolean;
import java.lang.Class;
import java.lang.Exception;
import java.lang.Integer;
import java.lang.Long;
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
public final class EntryDao_Impl implements EntryDao {
  private final RoomDatabase __db;

  private final SharedSQLiteStatement __preparedStmtOfDeleteEntriesForFeed;

  private final SharedSQLiteStatement __preparedStmtOfDeleteOldEntries;

  private final EntityUpsertionAdapter<EntryEntity> __upsertionAdapterOfEntryEntity;

  public EntryDao_Impl(@NonNull final RoomDatabase __db) {
    this.__db = __db;
    this.__preparedStmtOfDeleteEntriesForFeed = new SharedSQLiteStatement(__db) {
      @Override
      @NonNull
      public String createQuery() {
        final String _query = "DELETE FROM entries WHERE feedId = ?";
        return _query;
      }
    };
    this.__preparedStmtOfDeleteOldEntries = new SharedSQLiteStatement(__db) {
      @Override
      @NonNull
      public String createQuery() {
        final String _query = "DELETE FROM entries WHERE fetchedAt < ?";
        return _query;
      }
    };
    this.__upsertionAdapterOfEntryEntity = new EntityUpsertionAdapter<EntryEntity>(new EntityInsertionAdapter<EntryEntity>(__db) {
      @Override
      @NonNull
      protected String createQuery() {
        return "INSERT INTO `entries` (`id`,`feedId`,`url`,`title`,`author`,`summary`,`contentOriginal`,`contentCleaned`,`publishedAt`,`fetchedAt`,`feedTitle`,`lastSyncedAt`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)";
      }

      @Override
      protected void bind(@NonNull final SupportSQLiteStatement statement,
          @NonNull final EntryEntity entity) {
        statement.bindString(1, entity.getId());
        statement.bindString(2, entity.getFeedId());
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
        if (entity.getAuthor() == null) {
          statement.bindNull(5);
        } else {
          statement.bindString(5, entity.getAuthor());
        }
        if (entity.getSummary() == null) {
          statement.bindNull(6);
        } else {
          statement.bindString(6, entity.getSummary());
        }
        if (entity.getContentOriginal() == null) {
          statement.bindNull(7);
        } else {
          statement.bindString(7, entity.getContentOriginal());
        }
        if (entity.getContentCleaned() == null) {
          statement.bindNull(8);
        } else {
          statement.bindString(8, entity.getContentCleaned());
        }
        if (entity.getPublishedAt() == null) {
          statement.bindNull(9);
        } else {
          statement.bindLong(9, entity.getPublishedAt());
        }
        statement.bindLong(10, entity.getFetchedAt());
        if (entity.getFeedTitle() == null) {
          statement.bindNull(11);
        } else {
          statement.bindString(11, entity.getFeedTitle());
        }
        statement.bindLong(12, entity.getLastSyncedAt());
      }
    }, new EntityDeletionOrUpdateAdapter<EntryEntity>(__db) {
      @Override
      @NonNull
      protected String createQuery() {
        return "UPDATE `entries` SET `id` = ?,`feedId` = ?,`url` = ?,`title` = ?,`author` = ?,`summary` = ?,`contentOriginal` = ?,`contentCleaned` = ?,`publishedAt` = ?,`fetchedAt` = ?,`feedTitle` = ?,`lastSyncedAt` = ? WHERE `id` = ?";
      }

      @Override
      protected void bind(@NonNull final SupportSQLiteStatement statement,
          @NonNull final EntryEntity entity) {
        statement.bindString(1, entity.getId());
        statement.bindString(2, entity.getFeedId());
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
        if (entity.getAuthor() == null) {
          statement.bindNull(5);
        } else {
          statement.bindString(5, entity.getAuthor());
        }
        if (entity.getSummary() == null) {
          statement.bindNull(6);
        } else {
          statement.bindString(6, entity.getSummary());
        }
        if (entity.getContentOriginal() == null) {
          statement.bindNull(7);
        } else {
          statement.bindString(7, entity.getContentOriginal());
        }
        if (entity.getContentCleaned() == null) {
          statement.bindNull(8);
        } else {
          statement.bindString(8, entity.getContentCleaned());
        }
        if (entity.getPublishedAt() == null) {
          statement.bindNull(9);
        } else {
          statement.bindLong(9, entity.getPublishedAt());
        }
        statement.bindLong(10, entity.getFetchedAt());
        if (entity.getFeedTitle() == null) {
          statement.bindNull(11);
        } else {
          statement.bindString(11, entity.getFeedTitle());
        }
        statement.bindLong(12, entity.getLastSyncedAt());
        statement.bindString(13, entity.getId());
      }
    });
  }

  @Override
  public Object deleteEntriesForFeed(final String feedId,
      final Continuation<? super Unit> $completion) {
    return CoroutinesRoom.execute(__db, true, new Callable<Unit>() {
      @Override
      @NonNull
      public Unit call() throws Exception {
        final SupportSQLiteStatement _stmt = __preparedStmtOfDeleteEntriesForFeed.acquire();
        int _argIndex = 1;
        _stmt.bindString(_argIndex, feedId);
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
          __preparedStmtOfDeleteEntriesForFeed.release(_stmt);
        }
      }
    }, $completion);
  }

  @Override
  public Object deleteOldEntries(final long olderThan,
      final Continuation<? super Unit> $completion) {
    return CoroutinesRoom.execute(__db, true, new Callable<Unit>() {
      @Override
      @NonNull
      public Unit call() throws Exception {
        final SupportSQLiteStatement _stmt = __preparedStmtOfDeleteOldEntries.acquire();
        int _argIndex = 1;
        _stmt.bindLong(_argIndex, olderThan);
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
          __preparedStmtOfDeleteOldEntries.release(_stmt);
        }
      }
    }, $completion);
  }

  @Override
  public Object insertEntries(final List<EntryEntity> entries,
      final Continuation<? super Unit> $completion) {
    return CoroutinesRoom.execute(__db, true, new Callable<Unit>() {
      @Override
      @NonNull
      public Unit call() throws Exception {
        __db.beginTransaction();
        try {
          __upsertionAdapterOfEntryEntity.upsert(entries);
          __db.setTransactionSuccessful();
          return Unit.INSTANCE;
        } finally {
          __db.endTransaction();
        }
      }
    }, $completion);
  }

  @Override
  public Flow<List<EntryWithState>> getEntries(final String subscriptionId, final String tagId,
      final boolean uncategorized, final boolean unreadOnly, final boolean starredOnly,
      final String sortOrder, final int limit, final int offset) {
    final String _sql = "\n"
            + "        SELECT e.*, s.read, s.starred, s.readAt, s.starredAt\n"
            + "        FROM entries e\n"
            + "        LEFT JOIN entry_states s ON e.id = s.entryId\n"
            + "        WHERE (? IS NULL OR e.feedId = ?)\n"
            + "          AND (? IS NULL OR e.feedId IN (\n"
            + "              SELECT sub.feedId FROM subscriptions sub\n"
            + "              JOIN subscription_tags st ON sub.id = st.subscriptionId\n"
            + "              WHERE st.tagId = ?\n"
            + "          ))\n"
            + "          AND (? = 0 OR e.feedId IN (\n"
            + "              SELECT sub.feedId FROM subscriptions sub\n"
            + "              WHERE sub.id NOT IN (\n"
            + "                  SELECT st.subscriptionId FROM subscription_tags st\n"
            + "              )\n"
            + "          ))\n"
            + "          AND (? = 0 OR COALESCE(s.read, 0) = 0)\n"
            + "          AND (? = 0 OR COALESCE(s.starred, 0) = 1)\n"
            + "        ORDER BY\n"
            + "            CASE WHEN ? = 'newest' THEN COALESCE(e.publishedAt, e.fetchedAt) END DESC,\n"
            + "            CASE WHEN ? = 'newest' THEN e.id END DESC,\n"
            + "            CASE WHEN ? = 'oldest' THEN COALESCE(e.publishedAt, e.fetchedAt) END ASC,\n"
            + "            CASE WHEN ? = 'oldest' THEN e.id END ASC\n"
            + "        LIMIT ? OFFSET ?\n"
            + "        ";
    final RoomSQLiteQuery _statement = RoomSQLiteQuery.acquire(_sql, 13);
    int _argIndex = 1;
    if (subscriptionId == null) {
      _statement.bindNull(_argIndex);
    } else {
      _statement.bindString(_argIndex, subscriptionId);
    }
    _argIndex = 2;
    if (subscriptionId == null) {
      _statement.bindNull(_argIndex);
    } else {
      _statement.bindString(_argIndex, subscriptionId);
    }
    _argIndex = 3;
    if (tagId == null) {
      _statement.bindNull(_argIndex);
    } else {
      _statement.bindString(_argIndex, tagId);
    }
    _argIndex = 4;
    if (tagId == null) {
      _statement.bindNull(_argIndex);
    } else {
      _statement.bindString(_argIndex, tagId);
    }
    _argIndex = 5;
    final int _tmp = uncategorized ? 1 : 0;
    _statement.bindLong(_argIndex, _tmp);
    _argIndex = 6;
    final int _tmp_1 = unreadOnly ? 1 : 0;
    _statement.bindLong(_argIndex, _tmp_1);
    _argIndex = 7;
    final int _tmp_2 = starredOnly ? 1 : 0;
    _statement.bindLong(_argIndex, _tmp_2);
    _argIndex = 8;
    _statement.bindString(_argIndex, sortOrder);
    _argIndex = 9;
    _statement.bindString(_argIndex, sortOrder);
    _argIndex = 10;
    _statement.bindString(_argIndex, sortOrder);
    _argIndex = 11;
    _statement.bindString(_argIndex, sortOrder);
    _argIndex = 12;
    _statement.bindLong(_argIndex, limit);
    _argIndex = 13;
    _statement.bindLong(_argIndex, offset);
    return CoroutinesRoom.createFlow(__db, false, new String[] {"entries", "entry_states",
        "subscriptions", "subscription_tags"}, new Callable<List<EntryWithState>>() {
      @Override
      @NonNull
      public List<EntryWithState> call() throws Exception {
        final Cursor _cursor = DBUtil.query(__db, _statement, false, null);
        try {
          final int _cursorIndexOfId = CursorUtil.getColumnIndexOrThrow(_cursor, "id");
          final int _cursorIndexOfFeedId = CursorUtil.getColumnIndexOrThrow(_cursor, "feedId");
          final int _cursorIndexOfUrl = CursorUtil.getColumnIndexOrThrow(_cursor, "url");
          final int _cursorIndexOfTitle = CursorUtil.getColumnIndexOrThrow(_cursor, "title");
          final int _cursorIndexOfAuthor = CursorUtil.getColumnIndexOrThrow(_cursor, "author");
          final int _cursorIndexOfSummary = CursorUtil.getColumnIndexOrThrow(_cursor, "summary");
          final int _cursorIndexOfContentOriginal = CursorUtil.getColumnIndexOrThrow(_cursor, "contentOriginal");
          final int _cursorIndexOfContentCleaned = CursorUtil.getColumnIndexOrThrow(_cursor, "contentCleaned");
          final int _cursorIndexOfPublishedAt = CursorUtil.getColumnIndexOrThrow(_cursor, "publishedAt");
          final int _cursorIndexOfFetchedAt = CursorUtil.getColumnIndexOrThrow(_cursor, "fetchedAt");
          final int _cursorIndexOfFeedTitle = CursorUtil.getColumnIndexOrThrow(_cursor, "feedTitle");
          final int _cursorIndexOfLastSyncedAt = CursorUtil.getColumnIndexOrThrow(_cursor, "lastSyncedAt");
          final int _cursorIndexOfRead = CursorUtil.getColumnIndexOrThrow(_cursor, "read");
          final int _cursorIndexOfStarred = CursorUtil.getColumnIndexOrThrow(_cursor, "starred");
          final int _cursorIndexOfReadAt = CursorUtil.getColumnIndexOrThrow(_cursor, "readAt");
          final int _cursorIndexOfStarredAt = CursorUtil.getColumnIndexOrThrow(_cursor, "starredAt");
          final List<EntryWithState> _result = new ArrayList<EntryWithState>(_cursor.getCount());
          while (_cursor.moveToNext()) {
            final EntryWithState _item;
            final Boolean _tmpRead;
            final Integer _tmp_3;
            if (_cursor.isNull(_cursorIndexOfRead)) {
              _tmp_3 = null;
            } else {
              _tmp_3 = _cursor.getInt(_cursorIndexOfRead);
            }
            _tmpRead = _tmp_3 == null ? null : _tmp_3 != 0;
            final Boolean _tmpStarred;
            final Integer _tmp_4;
            if (_cursor.isNull(_cursorIndexOfStarred)) {
              _tmp_4 = null;
            } else {
              _tmp_4 = _cursor.getInt(_cursorIndexOfStarred);
            }
            _tmpStarred = _tmp_4 == null ? null : _tmp_4 != 0;
            final Long _tmpReadAt;
            if (_cursor.isNull(_cursorIndexOfReadAt)) {
              _tmpReadAt = null;
            } else {
              _tmpReadAt = _cursor.getLong(_cursorIndexOfReadAt);
            }
            final Long _tmpStarredAt;
            if (_cursor.isNull(_cursorIndexOfStarredAt)) {
              _tmpStarredAt = null;
            } else {
              _tmpStarredAt = _cursor.getLong(_cursorIndexOfStarredAt);
            }
            final EntryEntity _tmpEntry;
            final String _tmpId;
            _tmpId = _cursor.getString(_cursorIndexOfId);
            final String _tmpFeedId;
            _tmpFeedId = _cursor.getString(_cursorIndexOfFeedId);
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
            final String _tmpAuthor;
            if (_cursor.isNull(_cursorIndexOfAuthor)) {
              _tmpAuthor = null;
            } else {
              _tmpAuthor = _cursor.getString(_cursorIndexOfAuthor);
            }
            final String _tmpSummary;
            if (_cursor.isNull(_cursorIndexOfSummary)) {
              _tmpSummary = null;
            } else {
              _tmpSummary = _cursor.getString(_cursorIndexOfSummary);
            }
            final String _tmpContentOriginal;
            if (_cursor.isNull(_cursorIndexOfContentOriginal)) {
              _tmpContentOriginal = null;
            } else {
              _tmpContentOriginal = _cursor.getString(_cursorIndexOfContentOriginal);
            }
            final String _tmpContentCleaned;
            if (_cursor.isNull(_cursorIndexOfContentCleaned)) {
              _tmpContentCleaned = null;
            } else {
              _tmpContentCleaned = _cursor.getString(_cursorIndexOfContentCleaned);
            }
            final Long _tmpPublishedAt;
            if (_cursor.isNull(_cursorIndexOfPublishedAt)) {
              _tmpPublishedAt = null;
            } else {
              _tmpPublishedAt = _cursor.getLong(_cursorIndexOfPublishedAt);
            }
            final long _tmpFetchedAt;
            _tmpFetchedAt = _cursor.getLong(_cursorIndexOfFetchedAt);
            final String _tmpFeedTitle;
            if (_cursor.isNull(_cursorIndexOfFeedTitle)) {
              _tmpFeedTitle = null;
            } else {
              _tmpFeedTitle = _cursor.getString(_cursorIndexOfFeedTitle);
            }
            final long _tmpLastSyncedAt;
            _tmpLastSyncedAt = _cursor.getLong(_cursorIndexOfLastSyncedAt);
            _tmpEntry = new EntryEntity(_tmpId,_tmpFeedId,_tmpUrl,_tmpTitle,_tmpAuthor,_tmpSummary,_tmpContentOriginal,_tmpContentCleaned,_tmpPublishedAt,_tmpFetchedAt,_tmpFeedTitle,_tmpLastSyncedAt);
            _item = new EntryWithState(_tmpEntry,_tmpRead,_tmpStarred,_tmpReadAt,_tmpStarredAt);
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
  public Object getEntry(final String id, final Continuation<? super EntryEntity> $completion) {
    final String _sql = "SELECT * FROM entries WHERE id = ?";
    final RoomSQLiteQuery _statement = RoomSQLiteQuery.acquire(_sql, 1);
    int _argIndex = 1;
    _statement.bindString(_argIndex, id);
    final CancellationSignal _cancellationSignal = DBUtil.createCancellationSignal();
    return CoroutinesRoom.execute(__db, false, _cancellationSignal, new Callable<EntryEntity>() {
      @Override
      @Nullable
      public EntryEntity call() throws Exception {
        final Cursor _cursor = DBUtil.query(__db, _statement, false, null);
        try {
          final int _cursorIndexOfId = CursorUtil.getColumnIndexOrThrow(_cursor, "id");
          final int _cursorIndexOfFeedId = CursorUtil.getColumnIndexOrThrow(_cursor, "feedId");
          final int _cursorIndexOfUrl = CursorUtil.getColumnIndexOrThrow(_cursor, "url");
          final int _cursorIndexOfTitle = CursorUtil.getColumnIndexOrThrow(_cursor, "title");
          final int _cursorIndexOfAuthor = CursorUtil.getColumnIndexOrThrow(_cursor, "author");
          final int _cursorIndexOfSummary = CursorUtil.getColumnIndexOrThrow(_cursor, "summary");
          final int _cursorIndexOfContentOriginal = CursorUtil.getColumnIndexOrThrow(_cursor, "contentOriginal");
          final int _cursorIndexOfContentCleaned = CursorUtil.getColumnIndexOrThrow(_cursor, "contentCleaned");
          final int _cursorIndexOfPublishedAt = CursorUtil.getColumnIndexOrThrow(_cursor, "publishedAt");
          final int _cursorIndexOfFetchedAt = CursorUtil.getColumnIndexOrThrow(_cursor, "fetchedAt");
          final int _cursorIndexOfFeedTitle = CursorUtil.getColumnIndexOrThrow(_cursor, "feedTitle");
          final int _cursorIndexOfLastSyncedAt = CursorUtil.getColumnIndexOrThrow(_cursor, "lastSyncedAt");
          final EntryEntity _result;
          if (_cursor.moveToFirst()) {
            final String _tmpId;
            _tmpId = _cursor.getString(_cursorIndexOfId);
            final String _tmpFeedId;
            _tmpFeedId = _cursor.getString(_cursorIndexOfFeedId);
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
            final String _tmpAuthor;
            if (_cursor.isNull(_cursorIndexOfAuthor)) {
              _tmpAuthor = null;
            } else {
              _tmpAuthor = _cursor.getString(_cursorIndexOfAuthor);
            }
            final String _tmpSummary;
            if (_cursor.isNull(_cursorIndexOfSummary)) {
              _tmpSummary = null;
            } else {
              _tmpSummary = _cursor.getString(_cursorIndexOfSummary);
            }
            final String _tmpContentOriginal;
            if (_cursor.isNull(_cursorIndexOfContentOriginal)) {
              _tmpContentOriginal = null;
            } else {
              _tmpContentOriginal = _cursor.getString(_cursorIndexOfContentOriginal);
            }
            final String _tmpContentCleaned;
            if (_cursor.isNull(_cursorIndexOfContentCleaned)) {
              _tmpContentCleaned = null;
            } else {
              _tmpContentCleaned = _cursor.getString(_cursorIndexOfContentCleaned);
            }
            final Long _tmpPublishedAt;
            if (_cursor.isNull(_cursorIndexOfPublishedAt)) {
              _tmpPublishedAt = null;
            } else {
              _tmpPublishedAt = _cursor.getLong(_cursorIndexOfPublishedAt);
            }
            final long _tmpFetchedAt;
            _tmpFetchedAt = _cursor.getLong(_cursorIndexOfFetchedAt);
            final String _tmpFeedTitle;
            if (_cursor.isNull(_cursorIndexOfFeedTitle)) {
              _tmpFeedTitle = null;
            } else {
              _tmpFeedTitle = _cursor.getString(_cursorIndexOfFeedTitle);
            }
            final long _tmpLastSyncedAt;
            _tmpLastSyncedAt = _cursor.getLong(_cursorIndexOfLastSyncedAt);
            _result = new EntryEntity(_tmpId,_tmpFeedId,_tmpUrl,_tmpTitle,_tmpAuthor,_tmpSummary,_tmpContentOriginal,_tmpContentCleaned,_tmpPublishedAt,_tmpFetchedAt,_tmpFeedTitle,_tmpLastSyncedAt);
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
  public Flow<EntryWithState> getEntryWithState(final String id) {
    final String _sql = "\n"
            + "        SELECT e.*, s.read, s.starred, s.readAt, s.starredAt\n"
            + "        FROM entries e\n"
            + "        LEFT JOIN entry_states s ON e.id = s.entryId\n"
            + "        WHERE e.id = ?\n"
            + "        ";
    final RoomSQLiteQuery _statement = RoomSQLiteQuery.acquire(_sql, 1);
    int _argIndex = 1;
    _statement.bindString(_argIndex, id);
    return CoroutinesRoom.createFlow(__db, false, new String[] {"entries",
        "entry_states"}, new Callable<EntryWithState>() {
      @Override
      @Nullable
      public EntryWithState call() throws Exception {
        final Cursor _cursor = DBUtil.query(__db, _statement, false, null);
        try {
          final int _cursorIndexOfId = CursorUtil.getColumnIndexOrThrow(_cursor, "id");
          final int _cursorIndexOfFeedId = CursorUtil.getColumnIndexOrThrow(_cursor, "feedId");
          final int _cursorIndexOfUrl = CursorUtil.getColumnIndexOrThrow(_cursor, "url");
          final int _cursorIndexOfTitle = CursorUtil.getColumnIndexOrThrow(_cursor, "title");
          final int _cursorIndexOfAuthor = CursorUtil.getColumnIndexOrThrow(_cursor, "author");
          final int _cursorIndexOfSummary = CursorUtil.getColumnIndexOrThrow(_cursor, "summary");
          final int _cursorIndexOfContentOriginal = CursorUtil.getColumnIndexOrThrow(_cursor, "contentOriginal");
          final int _cursorIndexOfContentCleaned = CursorUtil.getColumnIndexOrThrow(_cursor, "contentCleaned");
          final int _cursorIndexOfPublishedAt = CursorUtil.getColumnIndexOrThrow(_cursor, "publishedAt");
          final int _cursorIndexOfFetchedAt = CursorUtil.getColumnIndexOrThrow(_cursor, "fetchedAt");
          final int _cursorIndexOfFeedTitle = CursorUtil.getColumnIndexOrThrow(_cursor, "feedTitle");
          final int _cursorIndexOfLastSyncedAt = CursorUtil.getColumnIndexOrThrow(_cursor, "lastSyncedAt");
          final int _cursorIndexOfRead = CursorUtil.getColumnIndexOrThrow(_cursor, "read");
          final int _cursorIndexOfStarred = CursorUtil.getColumnIndexOrThrow(_cursor, "starred");
          final int _cursorIndexOfReadAt = CursorUtil.getColumnIndexOrThrow(_cursor, "readAt");
          final int _cursorIndexOfStarredAt = CursorUtil.getColumnIndexOrThrow(_cursor, "starredAt");
          final EntryWithState _result;
          if (_cursor.moveToFirst()) {
            final Boolean _tmpRead;
            final Integer _tmp;
            if (_cursor.isNull(_cursorIndexOfRead)) {
              _tmp = null;
            } else {
              _tmp = _cursor.getInt(_cursorIndexOfRead);
            }
            _tmpRead = _tmp == null ? null : _tmp != 0;
            final Boolean _tmpStarred;
            final Integer _tmp_1;
            if (_cursor.isNull(_cursorIndexOfStarred)) {
              _tmp_1 = null;
            } else {
              _tmp_1 = _cursor.getInt(_cursorIndexOfStarred);
            }
            _tmpStarred = _tmp_1 == null ? null : _tmp_1 != 0;
            final Long _tmpReadAt;
            if (_cursor.isNull(_cursorIndexOfReadAt)) {
              _tmpReadAt = null;
            } else {
              _tmpReadAt = _cursor.getLong(_cursorIndexOfReadAt);
            }
            final Long _tmpStarredAt;
            if (_cursor.isNull(_cursorIndexOfStarredAt)) {
              _tmpStarredAt = null;
            } else {
              _tmpStarredAt = _cursor.getLong(_cursorIndexOfStarredAt);
            }
            final EntryEntity _tmpEntry;
            final String _tmpId;
            _tmpId = _cursor.getString(_cursorIndexOfId);
            final String _tmpFeedId;
            _tmpFeedId = _cursor.getString(_cursorIndexOfFeedId);
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
            final String _tmpAuthor;
            if (_cursor.isNull(_cursorIndexOfAuthor)) {
              _tmpAuthor = null;
            } else {
              _tmpAuthor = _cursor.getString(_cursorIndexOfAuthor);
            }
            final String _tmpSummary;
            if (_cursor.isNull(_cursorIndexOfSummary)) {
              _tmpSummary = null;
            } else {
              _tmpSummary = _cursor.getString(_cursorIndexOfSummary);
            }
            final String _tmpContentOriginal;
            if (_cursor.isNull(_cursorIndexOfContentOriginal)) {
              _tmpContentOriginal = null;
            } else {
              _tmpContentOriginal = _cursor.getString(_cursorIndexOfContentOriginal);
            }
            final String _tmpContentCleaned;
            if (_cursor.isNull(_cursorIndexOfContentCleaned)) {
              _tmpContentCleaned = null;
            } else {
              _tmpContentCleaned = _cursor.getString(_cursorIndexOfContentCleaned);
            }
            final Long _tmpPublishedAt;
            if (_cursor.isNull(_cursorIndexOfPublishedAt)) {
              _tmpPublishedAt = null;
            } else {
              _tmpPublishedAt = _cursor.getLong(_cursorIndexOfPublishedAt);
            }
            final long _tmpFetchedAt;
            _tmpFetchedAt = _cursor.getLong(_cursorIndexOfFetchedAt);
            final String _tmpFeedTitle;
            if (_cursor.isNull(_cursorIndexOfFeedTitle)) {
              _tmpFeedTitle = null;
            } else {
              _tmpFeedTitle = _cursor.getString(_cursorIndexOfFeedTitle);
            }
            final long _tmpLastSyncedAt;
            _tmpLastSyncedAt = _cursor.getLong(_cursorIndexOfLastSyncedAt);
            _tmpEntry = new EntryEntity(_tmpId,_tmpFeedId,_tmpUrl,_tmpTitle,_tmpAuthor,_tmpSummary,_tmpContentOriginal,_tmpContentCleaned,_tmpPublishedAt,_tmpFetchedAt,_tmpFeedTitle,_tmpLastSyncedAt);
            _result = new EntryWithState(_tmpEntry,_tmpRead,_tmpStarred,_tmpReadAt,_tmpStarredAt);
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
  public Object getEntryCountForFeed(final String feedId,
      final Continuation<? super Integer> $completion) {
    final String _sql = "SELECT COUNT(*) FROM entries WHERE feedId = ?";
    final RoomSQLiteQuery _statement = RoomSQLiteQuery.acquire(_sql, 1);
    int _argIndex = 1;
    _statement.bindString(_argIndex, feedId);
    final CancellationSignal _cancellationSignal = DBUtil.createCancellationSignal();
    return CoroutinesRoom.execute(__db, false, _cancellationSignal, new Callable<Integer>() {
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
          _statement.release();
        }
      }
    }, $completion);
  }

  @Override
  public Object getEntryIds(final String subscriptionId, final String tagId,
      final boolean uncategorized, final boolean unreadOnly, final boolean starredOnly,
      final String sortOrder, final Continuation<? super List<String>> $completion) {
    final String _sql = "\n"
            + "        SELECT e.id\n"
            + "        FROM entries e\n"
            + "        LEFT JOIN entry_states s ON e.id = s.entryId\n"
            + "        WHERE (? IS NULL OR e.feedId = ?)\n"
            + "          AND (? IS NULL OR e.feedId IN (\n"
            + "              SELECT sub.feedId FROM subscriptions sub\n"
            + "              JOIN subscription_tags st ON sub.id = st.subscriptionId\n"
            + "              WHERE st.tagId = ?\n"
            + "          ))\n"
            + "          AND (? = 0 OR e.feedId IN (\n"
            + "              SELECT sub.feedId FROM subscriptions sub\n"
            + "              WHERE sub.id NOT IN (\n"
            + "                  SELECT st.subscriptionId FROM subscription_tags st\n"
            + "              )\n"
            + "          ))\n"
            + "          AND (? = 0 OR COALESCE(s.read, 0) = 0)\n"
            + "          AND (? = 0 OR COALESCE(s.starred, 0) = 1)\n"
            + "        ORDER BY\n"
            + "            CASE WHEN ? = 'newest' THEN COALESCE(e.publishedAt, e.fetchedAt) END DESC,\n"
            + "            CASE WHEN ? = 'newest' THEN e.id END DESC,\n"
            + "            CASE WHEN ? = 'oldest' THEN COALESCE(e.publishedAt, e.fetchedAt) END ASC,\n"
            + "            CASE WHEN ? = 'oldest' THEN e.id END ASC\n"
            + "        ";
    final RoomSQLiteQuery _statement = RoomSQLiteQuery.acquire(_sql, 11);
    int _argIndex = 1;
    if (subscriptionId == null) {
      _statement.bindNull(_argIndex);
    } else {
      _statement.bindString(_argIndex, subscriptionId);
    }
    _argIndex = 2;
    if (subscriptionId == null) {
      _statement.bindNull(_argIndex);
    } else {
      _statement.bindString(_argIndex, subscriptionId);
    }
    _argIndex = 3;
    if (tagId == null) {
      _statement.bindNull(_argIndex);
    } else {
      _statement.bindString(_argIndex, tagId);
    }
    _argIndex = 4;
    if (tagId == null) {
      _statement.bindNull(_argIndex);
    } else {
      _statement.bindString(_argIndex, tagId);
    }
    _argIndex = 5;
    final int _tmp = uncategorized ? 1 : 0;
    _statement.bindLong(_argIndex, _tmp);
    _argIndex = 6;
    final int _tmp_1 = unreadOnly ? 1 : 0;
    _statement.bindLong(_argIndex, _tmp_1);
    _argIndex = 7;
    final int _tmp_2 = starredOnly ? 1 : 0;
    _statement.bindLong(_argIndex, _tmp_2);
    _argIndex = 8;
    _statement.bindString(_argIndex, sortOrder);
    _argIndex = 9;
    _statement.bindString(_argIndex, sortOrder);
    _argIndex = 10;
    _statement.bindString(_argIndex, sortOrder);
    _argIndex = 11;
    _statement.bindString(_argIndex, sortOrder);
    final CancellationSignal _cancellationSignal = DBUtil.createCancellationSignal();
    return CoroutinesRoom.execute(__db, false, _cancellationSignal, new Callable<List<String>>() {
      @Override
      @NonNull
      public List<String> call() throws Exception {
        final Cursor _cursor = DBUtil.query(__db, _statement, false, null);
        try {
          final List<String> _result = new ArrayList<String>(_cursor.getCount());
          while (_cursor.moveToNext()) {
            final String _item;
            _item = _cursor.getString(0);
            _result.add(_item);
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
  public Object deleteByIds(final List<String> ids, final Continuation<? super Unit> $completion) {
    return CoroutinesRoom.execute(__db, true, new Callable<Unit>() {
      @Override
      @NonNull
      public Unit call() throws Exception {
        final StringBuilder _stringBuilder = StringUtil.newStringBuilder();
        _stringBuilder.append("DELETE FROM entries WHERE id IN (");
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
