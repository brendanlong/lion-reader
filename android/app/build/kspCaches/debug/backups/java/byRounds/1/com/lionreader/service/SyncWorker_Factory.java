package com.lionreader.service;

import android.content.Context;
import androidx.work.WorkerParameters;
import com.lionreader.data.repository.EntryRepository;
import com.lionreader.data.repository.SyncRepository;
import com.lionreader.data.sync.SyncErrorNotifier;
import dagger.internal.DaggerGenerated;
import dagger.internal.QualifierMetadata;
import dagger.internal.ScopeMetadata;
import javax.annotation.processing.Generated;
import javax.inject.Provider;

@ScopeMetadata
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
public final class SyncWorker_Factory {
  private final Provider<SyncRepository> syncRepositoryProvider;

  private final Provider<EntryRepository> entryRepositoryProvider;

  private final Provider<SyncErrorNotifier> syncErrorNotifierProvider;

  public SyncWorker_Factory(Provider<SyncRepository> syncRepositoryProvider,
      Provider<EntryRepository> entryRepositoryProvider,
      Provider<SyncErrorNotifier> syncErrorNotifierProvider) {
    this.syncRepositoryProvider = syncRepositoryProvider;
    this.entryRepositoryProvider = entryRepositoryProvider;
    this.syncErrorNotifierProvider = syncErrorNotifierProvider;
  }

  public SyncWorker get(Context appContext, WorkerParameters workerParams) {
    return newInstance(appContext, workerParams, syncRepositoryProvider.get(), entryRepositoryProvider.get(), syncErrorNotifierProvider.get());
  }

  public static SyncWorker_Factory create(Provider<SyncRepository> syncRepositoryProvider,
      Provider<EntryRepository> entryRepositoryProvider,
      Provider<SyncErrorNotifier> syncErrorNotifierProvider) {
    return new SyncWorker_Factory(syncRepositoryProvider, entryRepositoryProvider, syncErrorNotifierProvider);
  }

  public static SyncWorker newInstance(Context appContext, WorkerParameters workerParams,
      SyncRepository syncRepository, EntryRepository entryRepository,
      SyncErrorNotifier syncErrorNotifier) {
    return new SyncWorker(appContext, workerParams, syncRepository, entryRepository, syncErrorNotifier);
  }
}
