package com.lionreader.data.repository;

import com.lionreader.data.api.LionReaderApi;
import com.lionreader.data.db.dao.SubscriptionDao;
import com.lionreader.data.db.dao.TagDao;
import dagger.internal.DaggerGenerated;
import dagger.internal.Factory;
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
public final class SubscriptionRepository_Factory implements Factory<SubscriptionRepository> {
  private final Provider<LionReaderApi> apiProvider;

  private final Provider<SubscriptionDao> subscriptionDaoProvider;

  private final Provider<TagDao> tagDaoProvider;

  public SubscriptionRepository_Factory(Provider<LionReaderApi> apiProvider,
      Provider<SubscriptionDao> subscriptionDaoProvider, Provider<TagDao> tagDaoProvider) {
    this.apiProvider = apiProvider;
    this.subscriptionDaoProvider = subscriptionDaoProvider;
    this.tagDaoProvider = tagDaoProvider;
  }

  @Override
  public SubscriptionRepository get() {
    return newInstance(apiProvider.get(), subscriptionDaoProvider.get(), tagDaoProvider.get());
  }

  public static SubscriptionRepository_Factory create(Provider<LionReaderApi> apiProvider,
      Provider<SubscriptionDao> subscriptionDaoProvider, Provider<TagDao> tagDaoProvider) {
    return new SubscriptionRepository_Factory(apiProvider, subscriptionDaoProvider, tagDaoProvider);
  }

  public static SubscriptionRepository newInstance(LionReaderApi api,
      SubscriptionDao subscriptionDao, TagDao tagDao) {
    return new SubscriptionRepository(api, subscriptionDao, tagDao);
  }
}
