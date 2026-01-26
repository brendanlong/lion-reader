package com.lionreader.data.repository;

import com.lionreader.data.api.LionReaderApi;
import com.lionreader.data.api.SessionStore;
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
public final class AuthRepository_Factory implements Factory<AuthRepository> {
  private final Provider<LionReaderApi> apiProvider;

  private final Provider<SessionStore> sessionStoreProvider;

  public AuthRepository_Factory(Provider<LionReaderApi> apiProvider,
      Provider<SessionStore> sessionStoreProvider) {
    this.apiProvider = apiProvider;
    this.sessionStoreProvider = sessionStoreProvider;
  }

  @Override
  public AuthRepository get() {
    return newInstance(apiProvider.get(), sessionStoreProvider.get());
  }

  public static AuthRepository_Factory create(Provider<LionReaderApi> apiProvider,
      Provider<SessionStore> sessionStoreProvider) {
    return new AuthRepository_Factory(apiProvider, sessionStoreProvider);
  }

  public static AuthRepository newInstance(LionReaderApi api, SessionStore sessionStore) {
    return new AuthRepository(api, sessionStore);
  }
}
