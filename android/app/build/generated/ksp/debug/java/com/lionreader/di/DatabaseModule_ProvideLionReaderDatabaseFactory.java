package com.lionreader.di;

import android.content.Context;
import com.lionreader.data.db.LionReaderDatabase;
import dagger.internal.DaggerGenerated;
import dagger.internal.Factory;
import dagger.internal.Preconditions;
import dagger.internal.QualifierMetadata;
import dagger.internal.ScopeMetadata;
import javax.annotation.processing.Generated;
import javax.inject.Provider;

@ScopeMetadata("javax.inject.Singleton")
@QualifierMetadata("dagger.hilt.android.qualifiers.ApplicationContext")
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
public final class DatabaseModule_ProvideLionReaderDatabaseFactory implements Factory<LionReaderDatabase> {
  private final Provider<Context> contextProvider;

  public DatabaseModule_ProvideLionReaderDatabaseFactory(Provider<Context> contextProvider) {
    this.contextProvider = contextProvider;
  }

  @Override
  public LionReaderDatabase get() {
    return provideLionReaderDatabase(contextProvider.get());
  }

  public static DatabaseModule_ProvideLionReaderDatabaseFactory create(
      Provider<Context> contextProvider) {
    return new DatabaseModule_ProvideLionReaderDatabaseFactory(contextProvider);
  }

  public static LionReaderDatabase provideLionReaderDatabase(Context context) {
    return Preconditions.checkNotNullFromProvides(DatabaseModule.INSTANCE.provideLionReaderDatabase(context));
  }
}
