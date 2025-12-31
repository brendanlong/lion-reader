# ProGuard/R8 Rules for Lion Reader Android App
# ================================================

# Keep line numbers for crash reporting
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# ================================================
# Kotlin
# ================================================
-dontwarn kotlin.**
-keep class kotlin.Metadata { *; }
-keepclassmembers class kotlin.Metadata {
    public <methods>;
}

# Kotlin Coroutines
-keepnames class kotlinx.coroutines.internal.MainDispatcherFactory {}
-keepnames class kotlinx.coroutines.CoroutineExceptionHandler {}
-keepclassmembers class kotlinx.coroutines.** {
    volatile <fields>;
}
-keepclassmembernames class kotlinx.** {
    volatile <fields>;
}

# ================================================
# kotlinx.serialization
# ================================================
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt

# Keep serializers
-keep,includedescriptorclasses class com.lionreader.**$$serializer { *; }
-keepclassmembers class com.lionreader.** {
    *** Companion;
}
-keepclasseswithmembers class com.lionreader.** {
    kotlinx.serialization.KSerializer serializer(...);
}

# Keep @Serializable classes
-keepclassmembers @kotlinx.serialization.Serializable class ** {
    # lookup for plugin generated serializable classes
    *** Companion;
    # lookup for serializable objects
    *** INSTANCE;
    kotlinx.serialization.KSerializer serializer(...);
}

# Keep @Serializable enum classes
-keepclassmembers @kotlinx.serialization.Serializable class ** extends java.lang.Enum {
    <fields>;
    **[] values();
    ** valueOf(java.lang.String);
}

# Serialization core
-keep class kotlinx.serialization.** { *; }
-keep interface kotlinx.serialization.** { *; }
-keepclassmembers class kotlinx.serialization.json.** { *; }

# ================================================
# API Models (kotlinx.serialization)
# ================================================
-keep class com.lionreader.data.api.models.** { *; }

# ================================================
# Room Database
# ================================================
-keep class * extends androidx.room.RoomDatabase
-keep @androidx.room.Entity class *
-dontwarn androidx.room.paging.**

# Room entities
-keep class com.lionreader.data.db.entities.** { *; }

# Room relations
-keep class com.lionreader.data.db.relations.** { *; }

# Room DAOs
-keep class com.lionreader.data.db.dao.** { *; }

# Room Database
-keep class com.lionreader.data.db.LionReaderDatabase { *; }

# ================================================
# Ktor Client
# ================================================
-keep class io.ktor.** { *; }
-keep class kotlinx.coroutines.** { *; }
-dontwarn kotlinx.atomicfu.**
-dontwarn io.netty.**
-dontwarn com.typesafe.**
-dontwarn org.slf4j.**

# Ktor serialization
-keepclassmembers class io.ktor.serialization.** { *; }

# Ktor client engines
-keep class io.ktor.client.engine.** { *; }
-keep class io.ktor.client.engine.okhttp.** { *; }
-keep class io.ktor.client.engine.cio.** { *; }

# Ktor network calls
-keep class io.ktor.client.call.** { *; }
-keep class io.ktor.client.request.** { *; }
-keep class io.ktor.client.statement.** { *; }

# ================================================
# OkHttp (Ktor dependency)
# ================================================
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**

-keepnames class okhttp3.internal.publicsuffix.PublicSuffixDatabase
-keep class okhttp3.** { *; }
-keep interface okhttp3.** { *; }

# ================================================
# Hilt / Dagger
# ================================================
-keepnames @dagger.hilt.android.lifecycle.HiltViewModel class * extends androidx.lifecycle.ViewModel
-keep class * extends androidx.lifecycle.ViewModel {
    <init>();
}

# Keep Hilt generated classes
-keep class **_HiltModules* { *; }
-keep class *_Factory { *; }
-keep class *_MembersInjector { *; }

# Dagger
-dontwarn com.google.errorprone.annotations.**

# Keep @Inject annotated constructors
-keepclasseswithmembernames class * {
    @javax.inject.Inject <init>(...);
}

# Keep @Inject annotated fields and methods
-keepclassmembers class * {
    @javax.inject.Inject <fields>;
    @javax.inject.Inject <methods>;
}

# Keep @HiltWorker annotated classes
-keep @androidx.hilt.work.HiltWorker class * { *; }

# ================================================
# WorkManager
# ================================================
-keep class * extends androidx.work.Worker
-keep class * extends androidx.work.ListenableWorker {
    public <init>(android.content.Context, androidx.work.WorkerParameters);
}
-keep class com.lionreader.service.SyncWorker { *; }

# ================================================
# AndroidX / Jetpack
# ================================================
-keep class androidx.** { *; }
-keep interface androidx.** { *; }

# DataStore
-keep class androidx.datastore.** { *; }

# Lifecycle
-keep class androidx.lifecycle.** { *; }
-keepclassmembers class * implements androidx.lifecycle.LifecycleObserver {
    <init>(...);
}
-keepclassmembers class * {
    @androidx.lifecycle.OnLifecycleEvent *;
}

# Navigation
-keep class androidx.navigation.** { *; }

# Compose
-keep class androidx.compose.** { *; }
-dontwarn androidx.compose.**

# ================================================
# Security Crypto
# ================================================
-keep class androidx.security.crypto.** { *; }
-keep class com.google.crypto.tink.** { *; }

# ================================================
# Coil (Image Loading)
# ================================================
-keep class coil.** { *; }
-keep interface coil.** { *; }

# ================================================
# App-specific keeps
# ================================================

# Keep Application class
-keep class com.lionreader.LionReaderApp { *; }

# Keep Activity classes
-keep class com.lionreader.MainActivity { *; }

# Keep ViewModels
-keep class com.lionreader.ui.** extends androidx.lifecycle.ViewModel { *; }

# Keep BuildConfig
-keep class com.lionreader.BuildConfig { *; }

# ================================================
# Enums
# ================================================
-keepclassmembers enum * {
    public static **[] values();
    public static ** valueOf(java.lang.String);
}

# ================================================
# Parcelable
# ================================================
-keepclassmembers class * implements android.os.Parcelable {
    public static final android.os.Parcelable$Creator CREATOR;
}

# ================================================
# Native methods
# ================================================
-keepclasseswithmembernames class * {
    native <methods>;
}

# ================================================
# Sentry
# ================================================
-keep class io.sentry.** { *; }
-keep interface io.sentry.** { *; }
-dontwarn io.sentry.**

# Keep Sentry's native libraries
-keep class io.sentry.android.ndk.** { *; }

# ================================================
# Debugging - remove for production if needed
# ================================================
# Uncomment the following to keep more info for debugging crashes:
# -keepattributes LocalVariableTable,LocalVariableTypeTable
