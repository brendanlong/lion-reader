package com.lionreader.di;

import com.lionreader.data.api.ApiClient;
import dagger.internal.DaggerGenerated;
import dagger.internal.Factory;
import dagger.internal.Preconditions;
import dagger.internal.QualifierMetadata;
import dagger.internal.ScopeMetadata;
import io.ktor.client.HttpClient;
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
public final class NetworkModule_ProvideHttpClientFactory implements Factory<HttpClient> {
  private final Provider<ApiClient> apiClientProvider;

  public NetworkModule_ProvideHttpClientFactory(Provider<ApiClient> apiClientProvider) {
    this.apiClientProvider = apiClientProvider;
  }

  @Override
  public HttpClient get() {
    return provideHttpClient(apiClientProvider.get());
  }

  public static NetworkModule_ProvideHttpClientFactory create(
      Provider<ApiClient> apiClientProvider) {
    return new NetworkModule_ProvideHttpClientFactory(apiClientProvider);
  }

  public static HttpClient provideHttpClient(ApiClient apiClient) {
    return Preconditions.checkNotNullFromProvides(NetworkModule.INSTANCE.provideHttpClient(apiClient));
  }
}
