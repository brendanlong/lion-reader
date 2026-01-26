package com.lionreader;

import com.lionreader.data.api.LionReaderApi;
import com.lionreader.data.api.SessionStore;
import dagger.MembersInjector;
import dagger.internal.DaggerGenerated;
import dagger.internal.InjectedFieldSignature;
import dagger.internal.QualifierMetadata;
import javax.annotation.processing.Generated;
import javax.inject.Provider;

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
public final class ShareReceiverActivity_MembersInjector implements MembersInjector<ShareReceiverActivity> {
  private final Provider<LionReaderApi> apiProvider;

  private final Provider<SessionStore> sessionStoreProvider;

  public ShareReceiverActivity_MembersInjector(Provider<LionReaderApi> apiProvider,
      Provider<SessionStore> sessionStoreProvider) {
    this.apiProvider = apiProvider;
    this.sessionStoreProvider = sessionStoreProvider;
  }

  public static MembersInjector<ShareReceiverActivity> create(Provider<LionReaderApi> apiProvider,
      Provider<SessionStore> sessionStoreProvider) {
    return new ShareReceiverActivity_MembersInjector(apiProvider, sessionStoreProvider);
  }

  @Override
  public void injectMembers(ShareReceiverActivity instance) {
    injectApi(instance, apiProvider.get());
    injectSessionStore(instance, sessionStoreProvider.get());
  }

  @InjectedFieldSignature("com.lionreader.ShareReceiverActivity.api")
  public static void injectApi(ShareReceiverActivity instance, LionReaderApi api) {
    instance.api = api;
  }

  @InjectedFieldSignature("com.lionreader.ShareReceiverActivity.sessionStore")
  public static void injectSessionStore(ShareReceiverActivity instance, SessionStore sessionStore) {
    instance.sessionStore = sessionStore;
  }
}
