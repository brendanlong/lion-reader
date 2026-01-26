package com.lionreader.ui.entries;

import androidx.lifecycle.SavedStateHandle;
import com.lionreader.data.repository.EntryRepository;
import com.lionreader.data.repository.SubscriptionRepository;
import com.lionreader.data.repository.TagRepository;
import com.lionreader.data.sync.ConnectivityMonitorInterface;
import com.lionreader.data.sync.SyncErrorNotifier;
import dagger.internal.DaggerGenerated;
import dagger.internal.Factory;
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
public final class EntryListViewModel_Factory implements Factory<EntryListViewModel> {
  private final Provider<SavedStateHandle> savedStateHandleProvider;

  private final Provider<EntryRepository> entryRepositoryProvider;

  private final Provider<SubscriptionRepository> subscriptionRepositoryProvider;

  private final Provider<TagRepository> tagRepositoryProvider;

  private final Provider<ConnectivityMonitorInterface> connectivityMonitorProvider;

  private final Provider<SyncErrorNotifier> syncErrorNotifierProvider;

  public EntryListViewModel_Factory(Provider<SavedStateHandle> savedStateHandleProvider,
      Provider<EntryRepository> entryRepositoryProvider,
      Provider<SubscriptionRepository> subscriptionRepositoryProvider,
      Provider<TagRepository> tagRepositoryProvider,
      Provider<ConnectivityMonitorInterface> connectivityMonitorProvider,
      Provider<SyncErrorNotifier> syncErrorNotifierProvider) {
    this.savedStateHandleProvider = savedStateHandleProvider;
    this.entryRepositoryProvider = entryRepositoryProvider;
    this.subscriptionRepositoryProvider = subscriptionRepositoryProvider;
    this.tagRepositoryProvider = tagRepositoryProvider;
    this.connectivityMonitorProvider = connectivityMonitorProvider;
    this.syncErrorNotifierProvider = syncErrorNotifierProvider;
  }

  @Override
  public EntryListViewModel get() {
    return newInstance(savedStateHandleProvider.get(), entryRepositoryProvider.get(), subscriptionRepositoryProvider.get(), tagRepositoryProvider.get(), connectivityMonitorProvider.get(), syncErrorNotifierProvider.get());
  }

  public static EntryListViewModel_Factory create(
      Provider<SavedStateHandle> savedStateHandleProvider,
      Provider<EntryRepository> entryRepositoryProvider,
      Provider<SubscriptionRepository> subscriptionRepositoryProvider,
      Provider<TagRepository> tagRepositoryProvider,
      Provider<ConnectivityMonitorInterface> connectivityMonitorProvider,
      Provider<SyncErrorNotifier> syncErrorNotifierProvider) {
    return new EntryListViewModel_Factory(savedStateHandleProvider, entryRepositoryProvider, subscriptionRepositoryProvider, tagRepositoryProvider, connectivityMonitorProvider, syncErrorNotifierProvider);
  }

  public static EntryListViewModel newInstance(SavedStateHandle savedStateHandle,
      EntryRepository entryRepository, SubscriptionRepository subscriptionRepository,
      TagRepository tagRepository, ConnectivityMonitorInterface connectivityMonitor,
      SyncErrorNotifier syncErrorNotifier) {
    return new EntryListViewModel(savedStateHandle, entryRepository, subscriptionRepository, tagRepository, connectivityMonitor, syncErrorNotifier);
  }
}
