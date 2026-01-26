package com.lionreader;

import com.lionreader.data.repository.AuthRepository;
import com.lionreader.di.AppConfig;
import dagger.MembersInjector;
import dagger.internal.DaggerGenerated;
import dagger.internal.InjectedFieldSignature;
import dagger.internal.QualifierMetadata;
import javax.annotation.processing.Generated;
import javax.inject.Provider;

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
public final class MainActivity_MembersInjector implements MembersInjector<MainActivity> {
  private final Provider<AppConfig> appConfigProvider;

  private final Provider<AuthRepository> authRepositoryProvider;

  public MainActivity_MembersInjector(Provider<AppConfig> appConfigProvider,
      Provider<AuthRepository> authRepositoryProvider) {
    this.appConfigProvider = appConfigProvider;
    this.authRepositoryProvider = authRepositoryProvider;
  }

  public static MembersInjector<MainActivity> create(Provider<AppConfig> appConfigProvider,
      Provider<AuthRepository> authRepositoryProvider) {
    return new MainActivity_MembersInjector(appConfigProvider, authRepositoryProvider);
  }

  @Override
  public void injectMembers(MainActivity instance) {
    injectAppConfig(instance, appConfigProvider.get());
    injectAuthRepository(instance, authRepositoryProvider.get());
  }

  @InjectedFieldSignature("com.lionreader.MainActivity.appConfig")
  public static void injectAppConfig(MainActivity instance, AppConfig appConfig) {
    instance.appConfig = appConfig;
  }

  @InjectedFieldSignature("com.lionreader.MainActivity.authRepository")
  public static void injectAuthRepository(MainActivity instance, AuthRepository authRepository) {
    instance.authRepository = authRepository;
  }
}
