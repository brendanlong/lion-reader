package com.lionreader.data.repository;

import com.lionreader.data.api.LionReaderApi;
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
public final class TagRepository_Factory implements Factory<TagRepository> {
  private final Provider<LionReaderApi> apiProvider;

  private final Provider<TagDao> tagDaoProvider;

  public TagRepository_Factory(Provider<LionReaderApi> apiProvider,
      Provider<TagDao> tagDaoProvider) {
    this.apiProvider = apiProvider;
    this.tagDaoProvider = tagDaoProvider;
  }

  @Override
  public TagRepository get() {
    return newInstance(apiProvider.get(), tagDaoProvider.get());
  }

  public static TagRepository_Factory create(Provider<LionReaderApi> apiProvider,
      Provider<TagDao> tagDaoProvider) {
    return new TagRepository_Factory(apiProvider, tagDaoProvider);
  }

  public static TagRepository newInstance(LionReaderApi api, TagDao tagDao) {
    return new TagRepository(api, tagDao);
  }
}
