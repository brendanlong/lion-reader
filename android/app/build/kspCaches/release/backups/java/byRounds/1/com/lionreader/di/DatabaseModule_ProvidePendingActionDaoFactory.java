package com.lionreader.di;

import com.lionreader.data.db.LionReaderDatabase;
import com.lionreader.data.db.dao.PendingActionDao;
import dagger.internal.DaggerGenerated;
import dagger.internal.Factory;
import dagger.internal.Preconditions;
import dagger.internal.QualifierMetadata;
import dagger.internal.ScopeMetadata;
import javax.annotation.processing.Generated;
import javax.inject.Provider;

@ScopeMetadata
@QualifierMetadata
@DaggerGenerated
@Generated(
    value = "dagger.internal.codegen.ComponentProcessor",
    comments = "https://dagger.dev"
)
@SuppressWarnings({
    "unchecked",
    "rawtypes",
    "KotlinInternal",
    "KotlinInternalInJava",
    "cast"
})
public final class DatabaseModule_ProvidePendingActionDaoFactory implements Factory<PendingActionDao> {
  private final Provider<LionReaderDatabase> databaseProvider;

  public DatabaseModule_ProvidePendingActionDaoFactory(
      Provider<LionReaderDatabase> databaseProvider) {
    this.databaseProvider = databaseProvider;
  }

  @Override
  public PendingActionDao get() {
    return providePendingActionDao(databaseProvider.get());
  }

  public static DatabaseModule_ProvidePendingActionDaoFactory create(
      Provider<LionReaderDatabase> databaseProvider) {
    return new DatabaseModule_ProvidePendingActionDaoFactory(databaseProvider);
  }

  public static PendingActionDao providePendingActionDao(LionReaderDatabase database) {
    return Preconditions.checkNotNullFromProvides(DatabaseModule.INSTANCE.providePendingActionDao(database));
  }
}
