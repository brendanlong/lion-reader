package com.lionreader.data.repository;

import com.lionreader.data.api.LionReaderApi;
import com.lionreader.data.db.dao.EntryStateDao;
import com.lionreader.data.db.dao.PendingActionDao;
import com.lionreader.data.sync.SyncErrorNotifier;
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
public final class SyncRepository_Factory implements Factory<SyncRepository> {
  private final Provider<LionReaderApi> apiProvider;

  private final Provider<PendingActionDao> pendingActionDaoProvider;

  private final Provider<EntryStateDao> entryStateDaoProvider;

  private final Provider<SyncErrorNotifier> syncErrorNotifierProvider;

  public SyncRepository_Factory(Provider<LionReaderApi> apiProvider,
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
    return newInstance(apiProvider.get(), pendingActionDaoProvider.get(), entryStateDaoProvider.get(), syncErrorNotifierProvider.get());
  }

  public static SyncRepository_Factory create(Provider<LionReaderApi> apiProvider,
      Provider<PendingActionDao> pendingActionDaoProvider,
      Provider<EntryStateDao> entryStateDaoProvider,
      Provider<SyncErrorNotifier> syncErrorNotifierProvider) {
    return new SyncRepository_Factory(apiProvider, pendingActionDaoProvider, entryStateDaoProvider, syncErrorNotifierProvider);
  }

  public static SyncRepository newInstance(LionReaderApi api, PendingActionDao pendingActionDao,
      EntryStateDao entryStateDao, SyncErrorNotifier syncErrorNotifier) {
    return new SyncRepository(api, pendingActionDao, entryStateDao, syncErrorNotifier);
  }
}
