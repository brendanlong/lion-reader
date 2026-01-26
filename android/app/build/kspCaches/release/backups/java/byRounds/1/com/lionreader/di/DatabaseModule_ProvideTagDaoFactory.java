package com.lionreader.di;

import com.lionreader.data.db.LionReaderDatabase;
import com.lionreader.data.db.dao.TagDao;
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
public final class DatabaseModule_ProvideTagDaoFactory implements Factory<TagDao> {
  private final Provider<LionReaderDatabase> databaseProvider;

  public DatabaseModule_ProvideTagDaoFactory(Provider<LionReaderDatabase> databaseProvider) {
    this.databaseProvider = databaseProvider;
  }

  @Override
  public TagDao get() {
    return provideTagDao(databaseProvider.get());
  }

  public static DatabaseModule_ProvideTagDaoFactory create(
      Provider<LionReaderDatabase> databaseProvider) {
    return new DatabaseModule_ProvideTagDaoFactory(databaseProvider);
  }

  public static TagDao provideTagDao(LionReaderDatabase database) {
    return Preconditions.checkNotNullFromProvides(DatabaseModule.INSTANCE.provideTagDao(database));
  }
}
