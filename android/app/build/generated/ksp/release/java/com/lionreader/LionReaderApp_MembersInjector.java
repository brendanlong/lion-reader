package com.lionreader;

import androidx.hilt.work.HiltWorkerFactory;
import com.lionreader.data.sync.SyncScheduler;
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
public final class LionReaderApp_MembersInjector implements MembersInjector<LionReaderApp> {
  private final Provider<HiltWorkerFactory> workerFactoryProvider;

  private final Provider<SyncScheduler> syncSchedulerProvider;

  public LionReaderApp_MembersInjector(Provider<HiltWorkerFactory> workerFactoryProvider,
      Provider<SyncScheduler> syncSchedulerProvider) {
    this.workerFactoryProvider = workerFactoryProvider;
    this.syncSchedulerProvider = syncSchedulerProvider;
  }

  public static MembersInjector<LionReaderApp> create(
      Provider<HiltWorkerFactory> workerFactoryProvider,
      Provider<SyncScheduler> syncSchedulerProvider) {
    return new LionReaderApp_MembersInjector(workerFactoryProvider, syncSchedulerProvider);
  }

  @Override
  public void injectMembers(LionReaderApp instance) {
    injectWorkerFactory(instance, workerFactoryProvider.get());
    injectSyncScheduler(instance, syncSchedulerProvider.get());
  }

  @InjectedFieldSignature("com.lionreader.LionReaderApp.workerFactory")
  public static void injectWorkerFactory(LionReaderApp instance, HiltWorkerFactory workerFactory) {
    instance.workerFactory = workerFactory;
  }

  @InjectedFieldSignature("com.lionreader.LionReaderApp.syncScheduler")
  public static void injectSyncScheduler(LionReaderApp instance, SyncScheduler syncScheduler) {
    instance.syncScheduler = syncScheduler;
  }
}
