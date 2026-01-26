package com.lionreader.data.api;

import com.lionreader.di.AppConfig;
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
public final class ApiClient_Factory implements Factory<ApiClient> {
  private final Provider<AppConfig> appConfigProvider;

  private final Provider<AuthInterceptor> authInterceptorProvider;

  public ApiClient_Factory(Provider<AppConfig> appConfigProvider,
      Provider<AuthInterceptor> authInterceptorProvider) {
    this.appConfigProvider = appConfigProvider;
    this.authInterceptorProvider = authInterceptorProvider;
  }

  @Override
  public ApiClient get() {
    return newInstance(appConfigProvider.get(), authInterceptorProvider.get());
  }

  public static ApiClient_Factory create(Provider<AppConfig> appConfigProvider,
      Provider<AuthInterceptor> authInterceptorProvider) {
    return new ApiClient_Factory(appConfigProvider, authInterceptorProvider);
  }

  public static ApiClient newInstance(AppConfig appConfig, AuthInterceptor authInterceptor) {
    return new ApiClient(appConfig, authInterceptor);
  }
}
