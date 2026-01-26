package com.lionreader.di;

import android.content.Context;
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
public final class AppModule_ProvideAppConfigFactory implements Factory<AppConfig> {
  private final Provider<Context> contextProvider;

  public AppModule_ProvideAppConfigFactory(Provider<Context> contextProvider) {
    this.contextProvider = contextProvider;
  }

  @Override
  public AppConfig get() {
    return provideAppConfig(contextProvider.get());
  }

  public static AppModule_ProvideAppConfigFactory create(Provider<Context> contextProvider) {
    return new AppModule_ProvideAppConfigFactory(contextProvider);
  }

  public static AppConfig provideAppConfig(Context context) {
    return Preconditions.checkNotNullFromProvides(AppModule.INSTANCE.provideAppConfig(context));
  }
}
