package com.lionreader.data.repository;

import com.lionreader.data.api.LionReaderApi;
import dagger.internal.DaggerGenerated;
import dagger.internal.Factory;
import dagger.internal.QualifierMetadata;
import dagger.internal.ScopeMetadata;
import javax.annotation.processing.Generated;
import javax.inject.Provider;

@ScopeMetadata("javax.inject.Singleton")
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
public final class SavedArticleRepository_Factory implements Factory<SavedArticleRepository> {
  private final Provider<LionReaderApi> apiProvider;

  public SavedArticleRepository_Factory(Provider<LionReaderApi> apiProvider) {
    this.apiProvider = apiProvider;
  }

  @Override
  public SavedArticleRepository get() {
    return newInstance(apiProvider.get());
  }

  public static SavedArticleRepository_Factory create(Provider<LionReaderApi> apiProvider) {
    return new SavedArticleRepository_Factory(apiProvider);
  }

  public static SavedArticleRepository newInstance(LionReaderApi api) {
    return new SavedArticleRepository(api);
  }
}
