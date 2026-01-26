package com.lionreader.ui.main;

import androidx.lifecycle.SavedStateHandle;
import com.lionreader.data.repository.SubscriptionRepository;
import com.lionreader.data.repository.TagRepository;
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
public final class MainViewModel_Factory implements Factory<MainViewModel> {
  private final Provider<SavedStateHandle> savedStateHandleProvider;

  private final Provider<SubscriptionRepository> subscriptionRepositoryProvider;

  private final Provider<TagRepository> tagRepositoryProvider;

  public MainViewModel_Factory(Provider<SavedStateHandle> savedStateHandleProvider,
      Provider<SubscriptionRepository> subscriptionRepositoryProvider,
      Provider<TagRepository> tagRepositoryProvider) {
    this.savedStateHandleProvider = savedStateHandleProvider;
    this.subscriptionRepositoryProvider = subscriptionRepositoryProvider;
    this.tagRepositoryProvider = tagRepositoryProvider;
  }

  @Override
  public MainViewModel get() {
    return newInstance(savedStateHandleProvider.get(), subscriptionRepositoryProvider.get(), tagRepositoryProvider.get());
  }

  public static MainViewModel_Factory create(Provider<SavedStateHandle> savedStateHandleProvider,
      Provider<SubscriptionRepository> subscriptionRepositoryProvider,
      Provider<TagRepository> tagRepositoryProvider) {
    return new MainViewModel_Factory(savedStateHandleProvider, subscriptionRepositoryProvider, tagRepositoryProvider);
  }

  public static MainViewModel newInstance(SavedStateHandle savedStateHandle,
      SubscriptionRepository subscriptionRepository, TagRepository tagRepository) {
    return new MainViewModel(savedStateHandle, subscriptionRepository, tagRepository);
  }
}
