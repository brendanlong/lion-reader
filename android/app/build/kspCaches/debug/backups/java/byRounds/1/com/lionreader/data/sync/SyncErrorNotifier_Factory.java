package com.lionreader.data.sync;

import dagger.internal.DaggerGenerated;
import dagger.internal.Factory;
import dagger.internal.QualifierMetadata;
import dagger.internal.ScopeMetadata;
import javax.annotation.processing.Generated;

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
public final class SyncErrorNotifier_Factory implements Factory<SyncErrorNotifier> {
  @Override
  public SyncErrorNotifier get() {
    return newInstance();
  }

  public static SyncErrorNotifier_Factory create() {
    return InstanceHolder.INSTANCE;
  }

  public static SyncErrorNotifier newInstance() {
    return new SyncErrorNotifier();
  }

  private static final class InstanceHolder {
    private static final SyncErrorNotifier_Factory INSTANCE = new SyncErrorNotifier_Factory();
  }
}
