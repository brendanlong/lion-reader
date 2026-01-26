package com.lionreader.di;

import com.lionreader.data.api.LionReaderApi;
import com.lionreader.data.api.SessionStore;
import com.lionreader.data.repository.AuthRepository;
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
public final class RepositoryModule_ProvideAuthRepositoryFactory implements Factory<AuthRepository> {
  private final Provider<LionReaderApi> apiProvider;

  private final Provider<SessionStore> sessionStoreProvider;

  public RepositoryModule_ProvideAuthRepositoryFactory(Provider<LionReaderApi> apiProvider,
      Provider<SessionStore> sessionStoreProvider) {
    this.apiProvider = apiProvider;
    this.sessionStoreProvider = sessionStoreProvider;
  }

  @Override
  public AuthRepository get() {
    return provideAuthRepository(apiProvider.get(), sessionStoreProvider.get());
  }

  public static RepositoryModule_ProvideAuthRepositoryFactory create(
      Provider<LionReaderApi> apiProvider, Provider<SessionStore> sessionStoreProvider) {
    return new RepositoryModule_ProvideAuthRepositoryFactory(apiProvider, sessionStoreProvider);
  }

  public static AuthRepository provideAuthRepository(LionReaderApi api, SessionStore sessionStore) {
    return Preconditions.checkNotNullFromProvides(RepositoryModule.INSTANCE.provideAuthRepository(api, sessionStore));
  }
}
