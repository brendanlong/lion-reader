package com.lionreader.data.api;

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
public final class LionReaderApiImpl_Factory implements Factory<LionReaderApiImpl> {
  private final Provider<ApiClient> apiClientProvider;

  public LionReaderApiImpl_Factory(Provider<ApiClient> apiClientProvider) {
    this.apiClientProvider = apiClientProvider;
  }

  @Override
  public LionReaderApiImpl get() {
    return newInstance(apiClientProvider.get());
  }

  public static LionReaderApiImpl_Factory create(Provider<ApiClient> apiClientProvider) {
    return new LionReaderApiImpl_Factory(apiClientProvider);
  }

  public static LionReaderApiImpl newInstance(ApiClient apiClient) {
    return new LionReaderApiImpl(apiClient);
  }
}
