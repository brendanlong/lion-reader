package com.lionreader.di;

import com.lionreader.data.api.ApiClient;
import com.lionreader.data.api.LionReaderApi;
import dagger.internal.DaggerGenerated;
import dagger.internal.Factory;
import dagger.internal.Preconditions;
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
public final class NetworkModule_ProvideLionReaderApiFactory implements Factory<LionReaderApi> {
  private final Provider<ApiClient> apiClientProvider;

  public NetworkModule_ProvideLionReaderApiFactory(Provider<ApiClient> apiClientProvider) {
    this.apiClientProvider = apiClientProvider;
  }

  @Override
  public LionReaderApi get() {
    return provideLionReaderApi(apiClientProvider.get());
  }

  public static NetworkModule_ProvideLionReaderApiFactory create(
      Provider<ApiClient> apiClientProvider) {
    return new NetworkModule_ProvideLionReaderApiFactory(apiClientProvider);
  }

  public static LionReaderApi provideLionReaderApi(ApiClient apiClient) {
    return Preconditions.checkNotNullFromProvides(NetworkModule.INSTANCE.provideLionReaderApi(apiClient));
  }
}
