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
public final class SyncScheduler_Factory implements Factory<SyncScheduler> {
  private final Provider<Context> contextProvider;

  private final Provider<ConnectivityMonitor> connectivityMonitorProvider;

  public SyncScheduler_Factory(Provider<Context> contextProvider,
      Provider<ConnectivityMonitor> connectivityMonitorProvider) {
    this.contextProvider = contextProvider;
    this.connectivityMonitorProvider = connectivityMonitorProvider;
  }

  @Override
  public SyncScheduler get() {
    return newInstance(contextProvider.get(), connectivityMonitorProvider.get());
  }

  public static SyncScheduler_Factory create(Provider<Context> contextProvider,
      Provider<ConnectivityMonitor> connectivityMonitorProvider) {
    return new SyncScheduler_Factory(contextProvider, connectivityMonitorProvider);
  }

  public static SyncScheduler newInstance(Context context,
      ConnectivityMonitor connectivityMonitor) {
    return new SyncScheduler(context, connectivityMonitor);
  }
}
