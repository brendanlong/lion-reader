package com.lionreader.di;

import com.lionreader.data.db.LionReaderDatabase;
import com.lionreader.data.db.dao.EntryStateDao;
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
public final class DatabaseModule_ProvideEntryStateDaoFactory implements Factory<EntryStateDao> {
  private final Provider<LionReaderDatabase> databaseProvider;

  public DatabaseModule_ProvideEntryStateDaoFactory(Provider<LionReaderDatabase> databaseProvider) {
    this.databaseProvider = databaseProvider;
  }

  @Override
  public EntryStateDao get() {
    return provideEntryStateDao(databaseProvider.get());
  }

  public static DatabaseModule_ProvideEntryStateDaoFactory create(
      Provider<LionReaderDatabase> databaseProvider) {
    return new DatabaseModule_ProvideEntryStateDaoFactory(databaseProvider);
  }

  public static EntryStateDao provideEntryStateDao(LionReaderDatabase database) {
    return Preconditions.checkNotNullFromProvides(DatabaseModule.INSTANCE.provideEntryStateDao(database));
  }
}
