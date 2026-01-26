package com.lionreader.di;

import com.lionreader.data.db.LionReaderDatabase;
import com.lionreader.data.db.dao.EntryDao;
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
public final class DatabaseModule_ProvideEntryDaoFactory implements Factory<EntryDao> {
  private final Provider<LionReaderDatabase> databaseProvider;

  public DatabaseModule_ProvideEntryDaoFactory(Provider<LionReaderDatabase> databaseProvider) {
    this.databaseProvider = databaseProvider;
  }

  @Override
  public EntryDao get() {
    return provideEntryDao(databaseProvider.get());
  }

  public static DatabaseModule_ProvideEntryDaoFactory create(
      Provider<LionReaderDatabase> databaseProvider) {
    return new DatabaseModule_ProvideEntryDaoFactory(databaseProvider);
  }

  public static EntryDao provideEntryDao(LionReaderDatabase database) {
    return Preconditions.checkNotNullFromProvides(DatabaseModule.INSTANCE.provideEntryDao(database));
  }
}
