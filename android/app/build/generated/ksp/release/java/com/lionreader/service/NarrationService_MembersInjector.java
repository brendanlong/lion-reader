package com.lionreader.service;

import com.lionreader.data.api.LionReaderApi;
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
public final class NarrationService_MembersInjector implements MembersInjector<NarrationService> {
  private final Provider<LionReaderApi> apiProvider;

  public NarrationService_MembersInjector(Provider<LionReaderApi> apiProvider) {
    this.apiProvider = apiProvider;
  }

  public static MembersInjector<NarrationService> create(Provider<LionReaderApi> apiProvider) {
    return new NarrationService_MembersInjector(apiProvider);
  }

  @Override
  public void injectMembers(NarrationService instance) {
    injectApi(instance, apiProvider.get());
  }

  @InjectedFieldSignature("com.lionreader.service.NarrationService.api")
  public static void injectApi(NarrationService instance, LionReaderApi api) {
    instance.api = api;
  }
}
