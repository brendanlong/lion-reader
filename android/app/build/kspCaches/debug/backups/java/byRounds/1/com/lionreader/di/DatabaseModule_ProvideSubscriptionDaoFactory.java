package com.lionreader.di;

import com.lionreader.data.db.LionReaderDatabase;
import com.lionreader.data.db.dao.SubscriptionDao;
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
public final class DatabaseModule_ProvideSubscriptionDaoFactory implements Factory<SubscriptionDao> {
  private final Provider<LionReaderDatabase> databaseProvider;

  public DatabaseModule_ProvideSubscriptionDaoFactory(
      Provider<LionReaderDatabase> databaseProvider) {
    this.databaseProvider = databaseProvider;
  }

  @Override
  public SubscriptionDao get() {
    return provideSubscriptionDao(databaseProvider.get());
  }

  public static DatabaseModule_ProvideSubscriptionDaoFactory create(
      Provider<LionReaderDatabase> databaseProvider) {
    return new DatabaseModule_ProvideSubscriptionDaoFactory(databaseProvider);
  }

  public static SubscriptionDao provideSubscriptionDao(LionReaderDatabase database) {
    return Preconditions.checkNotNullFromProvides(DatabaseModule.INSTANCE.provideSubscriptionDao(database));
  }
}
