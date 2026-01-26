package com.lionreader.ui.saved;

import com.lionreader.data.repository.SavedArticleRepository;
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
public final class SavedArticlesViewModel_Factory implements Factory<SavedArticlesViewModel> {
  private final Provider<SavedArticleRepository> savedArticleRepositoryProvider;

  public SavedArticlesViewModel_Factory(
      Provider<SavedArticleRepository> savedArticleRepositoryProvider) {
    this.savedArticleRepositoryProvider = savedArticleRepositoryProvider;
  }

  @Override
  public SavedArticlesViewModel get() {
    return newInstance(savedArticleRepositoryProvider.get());
  }

  public static SavedArticlesViewModel_Factory create(
      Provider<SavedArticleRepository> savedArticleRepositoryProvider) {
    return new SavedArticlesViewModel_Factory(savedArticleRepositoryProvider);
  }

  public static SavedArticlesViewModel newInstance(SavedArticleRepository savedArticleRepository) {
    return new SavedArticlesViewModel(savedArticleRepository);
  }
}
