package com.lionreader.ui.main;

import com.lionreader.data.repository.AuthRepository;
import com.lionreader.data.repository.EntryRepository;
import com.lionreader.data.repository.SavedArticleRepository;
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
public final class DrawerViewModel_Factory implements Factory<DrawerViewModel> {
  private final Provider<SubscriptionRepository> subscriptionRepositoryProvider;

  private final Provider<TagRepository> tagRepositoryProvider;

  private final Provider<AuthRepository> authRepositoryProvider;

  private final Provider<EntryRepository> entryRepositoryProvider;

  private final Provider<SavedArticleRepository> savedArticleRepositoryProvider;

  public DrawerViewModel_Factory(Provider<SubscriptionRepository> subscriptionRepositoryProvider,
      Provider<TagRepository> tagRepositoryProvider,
      Provider<AuthRepository> authRepositoryProvider,
      Provider<EntryRepository> entryRepositoryProvider,
      Provider<SavedArticleRepository> savedArticleRepositoryProvider) {
    this.subscriptionRepositoryProvider = subscriptionRepositoryProvider;
    this.tagRepositoryProvider = tagRepositoryProvider;
    this.authRepositoryProvider = authRepositoryProvider;
    this.entryRepositoryProvider = entryRepositoryProvider;
    this.savedArticleRepositoryProvider = savedArticleRepositoryProvider;
  }

  @Override
  public DrawerViewModel get() {
    return newInstance(subscriptionRepositoryProvider.get(), tagRepositoryProvider.get(), authRepositoryProvider.get(), entryRepositoryProvider.get(), savedArticleRepositoryProvider.get());
  }

  public static DrawerViewModel_Factory create(
      Provider<SubscriptionRepository> subscriptionRepositoryProvider,
      Provider<TagRepository> tagRepositoryProvider,
      Provider<AuthRepository> authRepositoryProvider,
      Provider<EntryRepository> entryRepositoryProvider,
      Provider<SavedArticleRepository> savedArticleRepositoryProvider) {
    return new DrawerViewModel_Factory(subscriptionRepositoryProvider, tagRepositoryProvider, authRepositoryProvider, entryRepositoryProvider, savedArticleRepositoryProvider);
  }

  public static DrawerViewModel newInstance(SubscriptionRepository subscriptionRepository,
      TagRepository tagRepository, AuthRepository authRepository, EntryRepository entryRepository,
      SavedArticleRepository savedArticleRepository) {
    return new DrawerViewModel(subscriptionRepository, tagRepository, authRepository, entryRepository, savedArticleRepository);
  }
}
