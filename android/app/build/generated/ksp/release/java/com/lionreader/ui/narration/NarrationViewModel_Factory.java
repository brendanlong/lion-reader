package com.lionreader.ui.narration;

import android.content.Context;
import dagger.internal.DaggerGenerated;
import dagger.internal.Factory;
import dagger.internal.QualifierMetadata;
import dagger.internal.ScopeMetadata;
import javax.annotation.processing.Generated;
import javax.inject.Provider;

@ScopeMetadata
@QualifierMetadata("dagger.hilt.android.qualifiers.ApplicationContext")
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
public final class NarrationViewModel_Factory implements Factory<NarrationViewModel> {
  private final Provider<Context> contextProvider;

  public NarrationViewModel_Factory(Provider<Context> contextProvider) {
    this.contextProvider = contextProvider;
  }

  @Override
  public NarrationViewModel get() {
    return newInstance(contextProvider.get());
  }

  public static NarrationViewModel_Factory create(Provider<Context> contextProvider) {
    return new NarrationViewModel_Factory(contextProvider);
  }

  public static NarrationViewModel newInstance(Context context) {
    return new NarrationViewModel(context);
  }
}
