package com.lionreader.ui.saved;

import androidx.lifecycle.SavedStateHandle;
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
public final class SavedArticleDetailViewModel_Factory implements Factory<SavedArticleDetailViewModel> {
  private final Provider<SavedStateHandle> savedStateHandleProvider;

  private final Provider<SavedArticleRepository> savedArticleRepositoryProvider;

  public SavedArticleDetailViewModel_Factory(Provider<SavedStateHandle> savedStateHandleProvider,
      Provider<SavedArticleRepository> savedArticleRepositoryProvider) {
    this.savedStateHandleProvider = savedStateHandleProvider;
    this.savedArticleRepositoryProvider = savedArticleRepositoryProvider;
  }

  @Override
  public SavedArticleDetailViewModel get() {
    return newInstance(savedStateHandleProvider.get(), savedArticleRepositoryProvider.get());
  }

  public static SavedArticleDetailViewModel_Factory create(
      Provider<SavedStateHandle> savedStateHandleProvider,
      Provider<SavedArticleRepository> savedArticleRepositoryProvider) {
    return new SavedArticleDetailViewModel_Factory(savedStateHandleProvider, savedArticleRepositoryProvider);
  }

  public static SavedArticleDetailViewModel newInstance(SavedStateHandle savedStateHandle,
      SavedArticleRepository savedArticleRepository) {
    return new SavedArticleDetailViewModel(savedStateHandle, savedArticleRepository);
  }
}
