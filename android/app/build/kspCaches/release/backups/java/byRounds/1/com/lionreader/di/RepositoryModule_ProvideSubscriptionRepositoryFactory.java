package com.lionreader.di;

import com.lionreader.data.api.LionReaderApi;
import com.lionreader.data.db.dao.SubscriptionDao;
import com.lionreader.data.db.dao.TagDao;
import com.lionreader.data.repository.SubscriptionRepository;
import dagger.internal.DaggerGenerated;
import dagger.internal.Factory;
import dagger.internal.Preconditions;
import dagger.internal.QualifierMetadata;
import dagger.internal.ScopeMetadata;
import javax.annotation.processing.Generated;
import javax.inject.Provider;

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
public final class RepositoryModule_ProvideSubscriptionRepositoryFactory implements Factory<SubscriptionRepository> {
  private final Provider<LionReaderApi> apiProvider;

  private final Provider<SubscriptionDao> subscriptionDaoProvider;

  private final Provider<TagDao> tagDaoProvider;

  public RepositoryModule_ProvideSubscriptionRepositoryFactory(Provider<LionReaderApi> apiProvider,
      Provider<SubscriptionDao> subscriptionDaoProvider, Provider<TagDao> tagDaoProvider) {
    this.apiProvider = apiProvider;
    this.subscriptionDaoProvider = subscriptionDaoProvider;
    this.tagDaoProvider = tagDaoProvider;
  }

  @Override
  public SubscriptionRepository get() {
    return provideSubscriptionRepository(apiProvider.get(), subscriptionDaoProvider.get(), tagDaoProvider.get());
  }

  public static RepositoryModule_ProvideSubscriptionRepositoryFactory create(
      Provider<LionReaderApi> apiProvider, Provider<SubscriptionDao> subscriptionDaoProvider,
      Provider<TagDao> tagDaoProvider) {
    return new RepositoryModule_ProvideSubscriptionRepositoryFactory(apiProvider, subscriptionDaoProvider, tagDaoProvider);
  }

  public static SubscriptionRepository provideSubscriptionRepository(LionReaderApi api,
      SubscriptionDao subscriptionDao, TagDao tagDao) {
    return Preconditions.checkNotNullFromProvides(RepositoryModule.INSTANCE.provideSubscriptionRepository(api, subscriptionDao, tagDao));
  }
}
