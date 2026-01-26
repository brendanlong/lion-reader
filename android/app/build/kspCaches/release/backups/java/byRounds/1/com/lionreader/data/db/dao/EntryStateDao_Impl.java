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
import com.lionreader.data.db.entities.EntryStateEntity;
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

@Generated("androidx.room.RoomProcessor")
@SuppressWarnings({"unchecked", "deprecation"})
public final class EntryStateDao_Impl implements EntryStateDao {
  private final RoomDatabase __db;

  private final EntityInsertionAdapter<EntryStateEntity> __insertionAdapterOfEntryStateEntity;

  private final SharedSQLiteStatement __preparedStmtOfMarkRead;

  private final SharedSQLiteStatement __preparedStmtOfSetStarred;

  private final SharedSQLiteStatement __preparedStmtOfDeleteState;

  private final SharedSQLiteStatement __preparedStmtOfUpdateReadStarred;

  public EntryStateDao_Impl(@NonNull final RoomDatabase __db) {
    this.__db = __db;
    this.__insertionAdapterOfEntryStateEntity = new EntityInsertionAdapter<EntryStateEntity>(__db) {
      @Override
      @NonNull
      protected String createQuery() {
        return "INSERT OR REPLACE INTO `entry_states` (`entryId`,`read`,`starred`,`readAt`,`starredAt`,`pendingSync`,`lastModifiedAt`) VALUES (?,?,?,?,?,?,?)";
      }

      @Override
      protected void bind(@NonNull final SupportSQLiteStatement statement,
          @NonNull final EntryStateEntity entity) {
        statement.bindString(1, entity.getEntryId());
        final int _tmp = entity.getRead() ? 1 : 0;
        statement.bindLong(2, _tmp);
        final int _tmp_1 = entity.getStarred() ? 1 : 0;
        statement.bindLong(3, _tmp_1);
        if (entity.getReadAt() == null) {
          statement.bindNull(4);
        } else {
          statement.bindLong(4, entity.getReadAt());
        }
        if (entity.getStarredAt() == null) {
          statement.bindNull(5);
        } else {
          statement.bindLong(5, entity.getStarredAt());
        }
        final int _tmp_2 = entity.getPendingSync() ? 1 : 0;
        statement.bindLong(6, _tmp_2);
        statement.bindLong(7, entity.getLastModifiedAt());
      }
    };
    this.__preparedStmtOfMarkRead = new SharedSQLiteStatement(__db) {
      @Override
      @NonNull
      public String createQuery() {
        final String _query = "\n"
                + "        UPDATE entry_states\n"
                + "        SET read = ?, readAt = ?, pendingSync = 1, lastModifiedAt = ?\n"
                + "        WHERE entryId = ?\n"
                + "        ";
        return _query;
      }
    };
    this.__preparedStmtOfSetStarred = new SharedSQLiteStatement(__db) {
      @Override
      @NonNull
      public String createQuery() {
        final String _query = "\n"
                + "        UPDATE entry_states\n"
                + "        SET starred = ?, starredAt = ?, pendingSync = 1, lastModifiedAt = ?\n"
                + "        WHERE entryId = ?\n"
                + "        ";
        return _query;
      }
    };
    this.__preparedStmtOfDeleteState = new SharedSQLiteStatement(__db) {
      @Override
      @NonNull
      public String createQuery() {
        final String _query = "DELETE FROM entry_states WHERE entryId = ?";
        return _query;
      }
    };
    this.__preparedStmtOfUpdateReadStarred = new SharedSQLiteStatement(__db) {
      @Override
      @NonNull
      public String createQuery() {
        final String _query = "\n"
                + "        UPDATE entry_states\n"
                + "        SET read = ?, starred = ?, lastModifiedAt = ?\n"
                + "        WHERE entryId = ?\n"
                + "        ";
        return _query;
      }
    };
  }

  @Override
  public Object upsertState(final EntryStateEntity state,
      final Continuation<? super Unit> $completion) {
    return CoroutinesRoom.execute(__db, true, new Callable<Unit>() {
      @Override
      @NonNull
      public Unit call() throws Exception {
        __db.beginTransaction();
        try {
          __insertionAdapterOfEntryStateEntity.insert(state);
          __db.setTransactionSuccessful();
          return Unit.INSTANCE;
        } finally {
          __db.endTransaction();
        }
      }
    }, $completion);
  }

  @Override
  public Object upsertStates(final List<EntryStateEntity> states,
      final Continuation<? super Unit> $completion) {
    return CoroutinesRoom.execute(__db, true, new Callable<Unit>() {
      @Override
      @NonNull
      public Unit call() throws Exception {
        __db.beginTransaction();
        try {
          __insertionAdapterOfEntryStateEntity.insert(states);
          __db.setTransactionSuccessful();
          return Unit.INSTANCE;
        } finally {
          __db.endTransaction();
        }
      }
    }, $completion);
  }

  @Override
  public Object markRead(final String entryId, final boolean read, final Long readAt,
      final long modifiedAt, final Continuation<? super Unit> $completion) {
    return CoroutinesRoom.execute(__db, true, new Callable<Unit>() {
      @Override
      @NonNull
      public Unit call() throws Exception {
        final SupportSQLiteStatement _stmt = __preparedStmtOfMarkRead.acquire();
        int _argIndex = 1;
        final int _tmp = read ? 1 : 0;
        _stmt.bindLong(_argIndex, _tmp);
        _argIndex = 2;
        if (readAt == null) {
          _stmt.bindNull(_argIndex);
        } else {
          _stmt.bindLong(_argIndex, readAt);
        }
        _argIndex = 3;
        _stmt.bindLong(_argIndex, modifiedAt);
        _argIndex = 4;
        _stmt.bindString(_argIndex, entryId);
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
          __preparedStmtOfMarkRead.release(_stmt);
        }
      }
    }, $completion);
  }

  @Override
  public Object setStarred(final String entryId, final boolean starred, final Long starredAt,
      final long modifiedAt, final Continuation<? super Unit> $completion) {
    return CoroutinesRoom.execute(__db, true, new Callable<Unit>() {
      @Override
      @NonNull
      public Unit call() throws Exception {
        final SupportSQLiteStatement _stmt = __preparedStmtOfSetStarred.acquire();
        int _argIndex = 1;
        final int _tmp = starred ? 1 : 0;
        _stmt.bindLong(_argIndex, _tmp);
        _argIndex = 2;
        if (starredAt == null) {
          _stmt.bindNull(_argIndex);
        } else {
          _stmt.bindLong(_argIndex, starredAt);
        }
        _argIndex = 3;
        _stmt.bindLong(_argIndex, modifiedAt);
        _argIndex = 4;
        _stmt.bindString(_argIndex, entryId);
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
          __preparedStmtOfSetStarred.release(_stmt);
        }
      }
    }, $completion);
  }

  @Override
  public Object deleteState(final String entryId, final Continuation<? super Unit> $completion) {
    return CoroutinesRoom.execute(__db, true, new Callable<Unit>() {
      @Override
      @NonNull
      public Unit call() throws Exception {
        final SupportSQLiteStatement _stmt = __preparedStmtOfDeleteState.acquire();
        int _argIndex = 1;
        _stmt.bindString(_argIndex, entryId);
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
          __preparedStmtOfDeleteState.release(_stmt);
        }
      }
    }, $completion);
  }

  @Override
  public Object updateReadStarred(final String entryId, final boolean read, final boolean starred,
      final long modifiedAt, final Continuation<? super Unit> $completion) {
    return CoroutinesRoom.execute(__db, true, new Callable<Unit>() {
      @Override
      @NonNull
      public Unit call() throws Exception {
        final SupportSQLiteStatement _stmt = __preparedStmtOfUpdateReadStarred.acquire();
        int _argIndex = 1;
        final int _tmp = read ? 1 : 0;
        _stmt.bindLong(_argIndex, _tmp);
        _argIndex = 2;
        final int _tmp_1 = starred ? 1 : 0;
        _stmt.bindLong(_argIndex, _tmp_1);
        _argIndex = 3;
        _stmt.bindLong(_argIndex, modifiedAt);
        _argIndex = 4;
        _stmt.bindString(_argIndex, entryId);
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
          __preparedStmtOfUpdateReadStarred.release(_stmt);
        }
      }
    }, $completion);
  }

  @Override
  public Object getState(final String entryId,
      final Continuation<? super EntryStateEntity> $completion) {
    final String _sql = "SELECT * FROM entry_states WHERE entryId = ?";
    final RoomSQLiteQuery _statement = RoomSQLiteQuery.acquire(_sql, 1);
    int _argIndex = 1;
    _statement.bindString(_argIndex, entryId);
    final CancellationSignal _cancellationSignal = DBUtil.createCancellationSignal();
    return CoroutinesRoom.execute(__db, false, _cancellationSignal, new Callable<EntryStateEntity>() {
      @Override
      @Nullable
      public EntryStateEntity call() throws Exception {
        final Cursor _cursor = DBUtil.query(__db, _statement, false, null);
        try {
          final int _cursorIndexOfEntryId = CursorUtil.getColumnIndexOrThrow(_cursor, "entryId");
          final int _cursorIndexOfRead = CursorUtil.getColumnIndexOrThrow(_cursor, "read");
          final int _cursorIndexOfStarred = CursorUtil.getColumnIndexOrThrow(_cursor, "starred");
          final int _cursorIndexOfReadAt = CursorUtil.getColumnIndexOrThrow(_cursor, "readAt");
          final int _cursorIndexOfStarredAt = CursorUtil.getColumnIndexOrThrow(_cursor, "starredAt");
          final int _cursorIndexOfPendingSync = CursorUtil.getColumnIndexOrThrow(_cursor, "pendingSync");
          final int _cursorIndexOfLastModifiedAt = CursorUtil.getColumnIndexOrThrow(_cursor, "lastModifiedAt");
          final EntryStateEntity _result;
          if (_cursor.moveToFirst()) {
            final String _tmpEntryId;
            _tmpEntryId = _cursor.getString(_cursorIndexOfEntryId);
            final boolean _tmpRead;
            final int _tmp;
            _tmp = _cursor.getInt(_cursorIndexOfRead);
            _tmpRead = _tmp != 0;
            final boolean _tmpStarred;
            final int _tmp_1;
            _tmp_1 = _cursor.getInt(_cursorIndexOfStarred);
            _tmpStarred = _tmp_1 != 0;
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
            final boolean _tmpPendingSync;
            final int _tmp_2;
            _tmp_2 = _cursor.getInt(_cursorIndexOfPendingSync);
            _tmpPendingSync = _tmp_2 != 0;
            final long _tmpLastModifiedAt;
            _tmpLastModifiedAt = _cursor.getLong(_cursorIndexOfLastModifiedAt);
            _result = new EntryStateEntity(_tmpEntryId,_tmpRead,_tmpStarred,_tmpReadAt,_tmpStarredAt,_tmpPendingSync,_tmpLastModifiedAt);
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
  public Object getPendingSyncEntryIds(final Continuation<? super List<String>> $completion) {
    final String _sql = "SELECT entryId FROM entry_states WHERE pendingSync = 1";
    final RoomSQLiteQuery _statement = RoomSQLiteQuery.acquire(_sql, 0);
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
  public Object getPendingSyncCount(final Continuation<? super Integer> $completion) {
    final String _sql = "SELECT COUNT(*) FROM entry_states WHERE pendingSync = 1";
    final RoomSQLiteQuery _statement = RoomSQLiteQuery.acquire(_sql, 0);
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
  public Object clearPendingSync(final List<String> entryIds,
      final Continuation<? super Unit> $completion) {
    return CoroutinesRoom.execute(__db, true, new Callable<Unit>() {
      @Override
      @NonNull
      public Unit call() throws Exception {
        final StringBuilder _stringBuilder = StringUtil.newStringBuilder();
        _stringBuilder.append("UPDATE entry_states SET pendingSync = 0 WHERE entryId IN (");
        final int _inputSize = entryIds.size();
        StringUtil.appendPlaceholders(_stringBuilder, _inputSize);
        _stringBuilder.append(")");
        final String _sql = _stringBuilder.toString();
        final SupportSQLiteStatement _stmt = __db.compileStatement(_sql);
        int _argIndex = 1;
        for (String _item : entryIds) {
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

  @Override
  public Object deleteByEntryIds(final List<String> entryIds,
      final Continuation<? super Unit> $completion) {
    return CoroutinesRoom.execute(__db, true, new Callable<Unit>() {
      @Override
      @NonNull
      public Unit call() throws Exception {
        final StringBuilder _stringBuilder = StringUtil.newStringBuilder();
        _stringBuilder.append("DELETE FROM entry_states WHERE entryId IN (");
        final int _inputSize = entryIds.size();
        StringUtil.appendPlaceholders(_stringBuilder, _inputSize);
        _stringBuilder.append(")");
        final String _sql = _stringBuilder.toString();
        final SupportSQLiteStatement _stmt = __db.compileStatement(_sql);
        int _argIndex = 1;
        for (String _item : entryIds) {
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
