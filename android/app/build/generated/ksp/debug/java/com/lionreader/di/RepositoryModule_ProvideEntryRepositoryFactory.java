package com.lionreader.di;

import com.lionreader.data.api.LionReaderApi;
import com.lionreader.data.db.dao.EntryDao;
import com.lionreader.data.db.dao.EntryStateDao;
import com.lionreader.data.db.dao.PendingActionDao;
import com.lionreader.data.db.dao.SubscriptionDao;
import com.lionreader.data.db.dao.TagDao;
import com.lionreader.data.repository.EntryRepository;
import com.lionreader.data.repository.SyncRepository;
import com.lionreader.data.sync.ConnectivityMonitor;
import com.lionreader.data.sync.SyncPreferences;
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
public final class RepositoryModule_ProvideEntryRepositoryFactory implements Factory<EntryRepository> {
  private final Provider<LionReaderApi> apiProvider;

  private final Provider<EntryDao> entryDaoProvider;

  private final Provider<EntryStateDao> entryStateDaoProvider;

  private final Provider<PendingActionDao> pendingActionDaoProvider;

  private final Provider<SubscriptionDao> subscriptionDaoProvider;

  private final Provider<TagDao> tagDaoProvider;

  private final Provider<ConnectivityMonitor> connectivityMonitorProvider;

  private final Provider<SyncRepository> syncRepositoryProvider;

  private final Provider<SyncPreferences> syncPreferencesProvider;

  public RepositoryModule_ProvideEntryRepositoryFactory(Provider<LionReaderApi> apiProvider,
      Provider<EntryDao> entryDaoProvider, Provider<EntryStateDao> entryStateDaoProvider,
      Provider<PendingActionDao> pendingActionDaoProvider,
      Provider<SubscriptionDao> subscriptionDaoProvider, Provider<TagDao> tagDaoProvider,
      Provider<ConnectivityMonitor> connectivityMonitorProvider,
      Provider<SyncRepository> syncRepositoryProvider,
      Provider<SyncPreferences> syncPreferencesProvider) {
    this.apiProvider = apiProvider;
    this.entryDaoProvider = entryDaoProvider;
    this.entryStateDaoProvider = entryStateDaoProvider;
    this.pendingActionDaoProvider = pendingActionDaoProvider;
    this.subscriptionDaoProvider = subscriptionDaoProvider;
    this.tagDaoProvider = tagDaoProvider;
    this.connectivityMonitorProvider = connectivityMonitorProvider;
    this.syncRepositoryProvider = syncRepositoryProvider;
    this.syncPreferencesProvider = syncPreferencesProvider;
  }

  @Override
  public EntryRepository get() {
    return provideEntryRepository(apiProvider.get(), entryDaoProvider.get(), entryStateDaoProvider.get(), pendingActionDaoProvider.get(), subscriptionDaoProvider.get(), tagDaoProvider.get(), connectivityMonitorProvider.get(), syncRepositoryProvider.get(), syncPreferencesProvider.get());
  }

  public static RepositoryModule_ProvideEntryRepositoryFactory create(
      Provider<LionReaderApi> apiProvider, Provider<EntryDao> entryDaoProvider,
      Provider<EntryStateDao> entryStateDaoProvider,
      Provider<PendingActionDao> pendingActionDaoProvider,
      Provider<SubscriptionDao> subscriptionDaoProvider, Provider<TagDao> tagDaoProvider,
      Provider<ConnectivityMonitor> connectivityMonitorProvider,
      Provider<SyncRepository> syncRepositoryProvider,
      Provider<SyncPreferences> syncPreferencesProvider) {
    return new RepositoryModule_ProvideEntryRepositoryFactory(apiProvider, entryDaoProvider, entryStateDaoProvider, pendingActionDaoProvider, subscriptionDaoProvider, tagDaoProvider, connectivityMonitorProvider, syncRepositoryProvider, syncPreferencesProvider);
  }

  public static EntryRepository provideEntryRepository(LionReaderApi api, EntryDao entryDao,
      EntryStateDao entryStateDao, PendingActionDao pendingActionDao,
      SubscriptionDao subscriptionDao, TagDao tagDao, ConnectivityMonitor connectivityMonitor,
      SyncRepository syncRepository, SyncPreferences syncPreferences) {
    return Preconditions.checkNotNullFromProvides(RepositoryModule.INSTANCE.provideEntryRepository(api, entryDao, entryStateDao, pendingActionDao, subscriptionDao, tagDao, connectivityMonitor, syncRepository, syncPreferences));
  }
}
