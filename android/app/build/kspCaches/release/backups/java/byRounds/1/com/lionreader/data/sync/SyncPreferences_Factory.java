package com.lionreader.data.sync;

import android.content.Context;
import dagger.internal.DaggerGenerated;
import dagger.internal.Factory;
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
public final class SyncPreferences_Factory implements Factory<SyncPreferences> {
  private final Provider<Context> contextProvider;

  public SyncPreferences_Factory(Provider<Context> contextProvider) {
    this.contextProvider = contextProvider;
  }

  @Override
  public SyncPreferences get() {
    return newInstance(contextProvider.get());
  }

  public static SyncPreferences_Factory create(Provider<Context> contextProvider) {
    return new SyncPreferences_Factory(contextProvider);
  }

  public static SyncPreferences newInstance(Context context) {
    return new SyncPreferences(context);
  }
}
