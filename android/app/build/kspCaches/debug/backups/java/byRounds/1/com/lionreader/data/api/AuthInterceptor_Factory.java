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
public final class AuthInterceptor_Factory implements Factory<AuthInterceptor> {
  private final Provider<SessionStore> sessionStoreProvider;

  public AuthInterceptor_Factory(Provider<SessionStore> sessionStoreProvider) {
    this.sessionStoreProvider = sessionStoreProvider;
  }

  @Override
  public AuthInterceptor get() {
    return newInstance(sessionStoreProvider.get());
  }

  public static AuthInterceptor_Factory create(Provider<SessionStore> sessionStoreProvider) {
    return new AuthInterceptor_Factory(sessionStoreProvider);
  }

  public static AuthInterceptor newInstance(SessionStore sessionStore) {
    return new AuthInterceptor(sessionStore);
  }
}
