import com.android.build.api.variant.HostTestBuilder

plugins {
    // AGP 9 compiles Kotlin itself (built-in Kotlin), so no kotlin-android plugin.
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

kotlin { jvmToolchain(libs.versions.jdk.get().toInt()) }

android {
    namespace = "com.lionreader.app"
    compileSdk = libs.versions.androidCompileSdk.get().toInt()

    defaultConfig {
        applicationId = "com.lionreader.app"
        minSdk = libs.versions.androidMinSdk.get().toInt()
        targetSdk = libs.versions.androidTargetSdk.get().toInt()
        // Release builds get both from their android-v<version> tag (see
        // .github/workflows/android-release.yml).
        versionCode = providers.gradleProperty("lionReaderVersionCode").orNull?.toInt() ?: 1
        versionName = providers.gradleProperty("lionReaderVersionName").orNull ?: "0.1.0"
        // The host whose /oauth/app-callback the app claims as an App Link.
        // Point a debug build at a dev server with -PappLinkHost=<host>.
        manifestPlaceholders["appLinkHost"] =
            (project.findProperty("appLinkHost") as String?) ?: "lionreader.com"
    }

    // A private dev keystore, so debug builds from every machine share a key
    // the server can list in ANDROID_DEBUG_APP_CERT_SHA256 (see kmp/CLAUDE.md).
    // Without it, debug builds use the default debug key and can only sign in
    // to dev servers.
    val devKeystore = providers.gradleProperty("lionReaderDevKeystore").orNull
    val devSigning = devKeystore?.let {
        signingConfigs.create("dev") {
            storeFile = file(it)
            storePassword = providers.gradleProperty("lionReaderDevKeystorePassword").get()
            keyAlias = providers.gradleProperty("lionReaderDevKeyAlias").get()
            keyPassword = providers.gradleProperty("lionReaderDevKeyPassword").get()
        }
    }

    // The release (upload) key, from CI secrets. Without it, release builds are
    // unsigned.
    val releaseKeystore = providers.gradleProperty("lionReaderReleaseKeystore").orNull
    val releaseSigning = releaseKeystore?.let {
        signingConfigs.create("release") {
            storeFile = file(it)
            storePassword = providers.gradleProperty("lionReaderReleaseKeystorePassword").get()
            keyAlias = providers.gradleProperty("lionReaderReleaseKeyAlias").get()
            keyPassword = providers.gradleProperty("lionReaderReleaseKeyPassword").get()
        }
    }

    buildTypes {
        debug {
            // Installs alongside the release app.
            applicationIdSuffix = ".debug"
            devSigning?.let { signingConfig = it }
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            releaseSigning?.let { signingConfig = it }
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    testOptions {
        unitTests {
            isIncludeAndroidResources = true
            all {
                // Robolectric 4.17 reads jdk.internal.access.SharedSecrets on
                // API 36+ (robolectric/robolectric#11434).
                it.jvmArgs("--add-exports=java.base/jdk.internal.access=ALL-UNNAMED")
                // Robolectric downloads its android-all jars to ~/.m2 by default;
                // keep them in the Gradle user home, which CI caches.
                it.jvmArgumentProviders.add(
                    RobolectricRepo(File(gradle.gradleUserHomeDir, "caches/robolectric").path)
                )
            }
        }
    }

    lint {
        lintConfig = rootProject.file("lint.xml")
        warningsAsErrors = true
        abortOnError = true
        checkDependencies = true
    }
}

/** Machine-specific path, so kept out of the test task's build-cache key. */
class RobolectricRepo(@get:Internal val dir: String) : CommandLineArgumentProvider {
    override fun asArguments(): List<String> = listOf("-Dmaven.repo.local=$dir")
}

androidComponents {
    // Compose UI tests need ui-test-manifest, which is debug-only; running the
    // same tests again against release adds time and nothing else.
    beforeVariants(selector().withBuildType("release")) { variant ->
        variant.hostTests[HostTestBuilder.UNIT_TEST_TYPE]?.enable = false
    }
}

dependencies {
    implementation(project(":shared"))
    implementation(libs.ktor.client.okhttp)
    implementation(libs.sqldelight.android.driver)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.adaptive.navigation3)
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.tooling.preview)
    debugImplementation(libs.androidx.compose.ui.tooling)

    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.browser)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.viewmodel.navigation3)
    implementation(libs.androidx.media3.exoplayer)
    implementation(libs.androidx.media3.session)
    implementation(libs.androidx.navigation3.runtime)
    implementation(libs.androidx.navigation3.ui)
    implementation(libs.androidx.work.runtime)
    implementation(libs.androidx.webkit)
    implementation(libs.coil.compose)
    implementation(libs.coil.network.okhttp)

    testImplementation(platform(libs.androidx.compose.bom))
    testImplementation(libs.androidx.compose.ui.test.junit4)
    // ui-test pulls in an Espresso that calls InputManager.getInstance(), which
    // API 37 removed.
    testImplementation(libs.androidx.test.espresso.core)
    testImplementation(libs.androidx.test.core)
    testImplementation(libs.androidx.test.ext.junit)
    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.ktor.client.mock)
    testImplementation(libs.robolectric)
    // Hosts the ComponentActivity that createComposeRule() launches.
    debugImplementation(libs.androidx.compose.ui.test.manifest)
}
