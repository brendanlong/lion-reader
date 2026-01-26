package com.lionreader.di;

import com.lionreader.data.api.LionReaderApi;
import com.lionreader.data.db.dao.EntryStateDao;
import com.lionreader.data.db.dao.PendingActionDao;
import com.lionreader.data.repository.SyncRepository;
import com.lionreader.data.sync.SyncErrorNotifier;
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
public final class RepositoryModule_ProvideSyncRepositoryFactory implements Factory<SyncRepository> {
  private final Provider<LionReaderApi> apiProvider;

  private final Provider<PendingActionDao> pendingActionDaoProvider;

  private final Provider<EntryStateDao> entryStateDaoProvider;

  private final Provider<SyncErrorNotifier> syncErrorNotifierProvider;

  public RepositoryModule_ProvideSyncRepositoryFactory(Provider<LionReaderApi> apiProvider,
      Provider<PendingActionDao> pendingActionDaoProvider,
      Provider<EntryStateDao> entryStateDaoProvider,
      Provider<SyncErrorNotifier> syncErrorNotifierProvider) {
    this.apiProvider = apiProvider;
    this.pendingActionDaoProvider = pendingActionDaoProvider;
    this.entryStateDaoProvider = entryStateDaoProvider;
    this.syncErrorNotifierProvider = syncErrorNotifierProvider;
  }

  @Override
  public SyncRepository get() {
    return provideSyncRepository(apiProvider.get(), pendingActionDaoProvider.get(), entryStateDaoProvider.get(), syncErrorNotifierProvider.get());
  }

  public static RepositoryModule_ProvideSyncRepositoryFactory create(
      Provider<LionReaderApi> apiProvider, Provider<PendingActionDao> pendingActionDaoProvider,
      Provider<EntryStateDao> entryStateDaoProvider,
      Provider<SyncErrorNotifier> syncErrorNotifierProvider) {
    return new RepositoryModule_ProvideSyncRepositoryFactory(apiProvider, pendingActionDaoProvider, entryStateDaoProvider, syncErrorNotifierProvider);
  }

  public static SyncRepository provideSyncRepository(LionReaderApi api,
      PendingActionDao pendingActionDao, EntryStateDao entryStateDao,
      SyncErrorNotifier syncErrorNotifier) {
    return Preconditions.checkNotNullFromProvides(RepositoryModule.INSTANCE.provideSyncRepository(api, pendingActionDao, entryStateDao, syncErrorNotifier));
  }
}
