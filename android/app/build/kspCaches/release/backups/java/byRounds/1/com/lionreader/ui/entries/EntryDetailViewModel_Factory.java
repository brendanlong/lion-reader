package com.lionreader.ui.entries;

import androidx.lifecycle.SavedStateHandle;
import com.lionreader.data.repository.EntryRepository;
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
public final class EntryDetailViewModel_Factory implements Factory<EntryDetailViewModel> {
  private final Provider<SavedStateHandle> savedStateHandleProvider;

  private final Provider<EntryRepository> entryRepositoryProvider;

  private final Provider<SyncErrorNotifier> syncErrorNotifierProvider;

  public EntryDetailViewModel_Factory(Provider<SavedStateHandle> savedStateHandleProvider,
      Provider<EntryRepository> entryRepositoryProvider,
      Provider<SyncErrorNotifier> syncErrorNotifierProvider) {
    this.savedStateHandleProvider = savedStateHandleProvider;
    this.entryRepositoryProvider = entryRepositoryProvider;
    this.syncErrorNotifierProvider = syncErrorNotifierProvider;
  }

  @Override
  public EntryDetailViewModel get() {
    return newInstance(savedStateHandleProvider.get(), entryRepositoryProvider.get(), syncErrorNotifierProvider.get());
  }

  public static EntryDetailViewModel_Factory create(
      Provider<SavedStateHandle> savedStateHandleProvider,
      Provider<EntryRepository> entryRepositoryProvider,
      Provider<SyncErrorNotifier> syncErrorNotifierProvider) {
    return new EntryDetailViewModel_Factory(savedStateHandleProvider, entryRepositoryProvider, syncErrorNotifierProvider);
  }

  public static EntryDetailViewModel newInstance(SavedStateHandle savedStateHandle,
      EntryRepository entryRepository, SyncErrorNotifier syncErrorNotifier) {
    return new EntryDetailViewModel(savedStateHandle, entryRepository, syncErrorNotifier);
  }
}
