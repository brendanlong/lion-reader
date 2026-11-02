import com.android.build.api.variant.HostTestBuilder
import java.security.KeyStore
import org.gradle.api.tasks.Exec

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
        // The host whose sign-in callback the app claims as an App Link.
        // Point a debug build at a dev server with -PappLinkHost=<host>.
        manifestPlaceholders["appLinkHost"] =
            (project.findProperty("appLinkHost") as String?) ?: "lionreader.com"
        signInCallbackPath("/oauth/app-callback")
    }

    // A private dev keystore, so debug builds from every machine share a key
    // the server can list in ANDROID_DEBUG_APP_CERT_SHA256 (see docs/android-dev.md).
    // Without it, debug builds use the default debug key and can only sign in
    // to dev servers.
    val devSigning = keystoreSigning("dev", "lionReaderDevKeystore")

    // The release (upload) key, from CI secrets. Without it, release builds are
    // unsigned.
    val releaseSigning = keystoreSigning("release", "lionReaderReleaseKeystore")

    buildTypes {
        debug {
            // Installs alongside the release app.
            applicationIdSuffix = ".debug"
            // Its own, so the release app installed alongside doesn't also
            // claim its sign-in redirects.
            signInCallbackPath("/oauth/app-callback/debug")
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

    // JNA (enhanced voices) ships ABIs Android no longer runs.
    packaging { jniLibs.excludes += listOf("lib/armeabi/**", "lib/mips/**", "lib/mips64/**") }

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

/** Phonon's native library for enhanced voices, built from Gradium's source by phonon/build.sh. */
abstract class BuildPhonon : Exec() {
    @get:OutputDirectory abstract val jniLibs: DirectoryProperty
}

val buildPhonon =
    tasks.register<BuildPhonon>("buildPhonon") {
        val script = rootProject.file("phonon/build.sh")
        val minSdk = libs.versions.androidMinSdk.get()
        inputs.file(script)
        // The Rust it builds with.
        inputs.file(rootProject.file("../rust-toolchain.toml"))
        inputs.property("minSdk", minSdk)
        jniLibs.set(layout.buildDirectory.dir("phonon/jniLibs"))
        val work = layout.buildDirectory.dir("phonon/work").get().asFile
        argumentProviders.add { listOf(script.path, jniLibs.get().asFile.path, work.path, minSdk) }
        executable = "bash"
        // GitHub's CodeQL default setup builds the app on a runner without cargo-ndk, and only
        // analyzes the Kotlin, so it does without the library.
        val codeql = providers.environmentVariable("CODEQL_EXTRACTOR_JAVA_ROOT")
        onlyIf("not under CodeQL") { !codeql.isPresent }
    }

androidComponents {
    // Compose UI tests need ui-test-manifest, which is debug-only; running the
    // same tests again against release adds time and nothing else.
    beforeVariants(selector().withBuildType("release")) { variant ->
        variant.hostTests[HostTestBuilder.UNIT_TEST_TYPE]?.enable = false
    }
    onVariants { variant ->
        variant.sources.jniLibs?.addGeneratedSourceDirectory(buildPhonon, BuildPhonon::jniLibs)
    }
    // x86_64 is for emulators; on every phone it would be 8 MB of nothing.
    onVariants(selector().withBuildType("release")) { variant ->
        variant.packaging.jniLibs.excludes.add("lib/x86_64/libptts_ffi.so")
    }
}

dependencies {
    implementation(project(":shared"))
    implementation(libs.ktor.client.okhttp)
    implementation(libs.jna) { artifact { type = "aar" } }
    implementation(libs.sqldelight.android.driver)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.adaptive.navigation3)
    implementation(libs.androidx.compose.ui)

    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.browser)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.media3.exoplayer)
    implementation(libs.androidx.media3.session)
    implementation(libs.androidx.navigation3.runtime)
    implementation(libs.androidx.navigation3.ui)
    implementation(libs.androidx.navigationevent.compose)
    implementation(libs.androidx.work.runtime)
    implementation(libs.androidx.webkit)

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
    testImplementation(libs.androidx.work.testing)
    testImplementation(libs.robolectric)
    // Hosts the ComponentActivity that createComposeRule() launches.
    debugImplementation(libs.androidx.compose.ui.test.manifest)
}

/** The path of the sign-in redirect: claimed in the manifest, and sent to the server. */
fun com.android.build.api.dsl.VariantDimension.signInCallbackPath(path: String) {
    manifestPlaceholders["appLinkPath"] = path
    buildConfigField("String", "SIGN_IN_CALLBACK_PATH", "\"$path\"")
}

/**
 * A signing config from the keystore at the `<property>` path, unlocked by `<property>Password`, or
 * null when the path isn't set. Each keystore holds just its one key, and PKCS12 (keytool's
 * default) has a single password for the store and its keys, so neither the alias nor a key
 * password is asked for.
 */
fun keystoreSigning(name: String, property: String) =
    providers.gradleProperty(property).orNull?.let { path ->
        val keystore = file(path)
        val password = providers.gradleProperty("${property}Password").get()
        android.signingConfigs.create(name) {
            storeFile = keystore
            storePassword = password
            keyAlias =
                KeyStore.getInstance(keystore, password.toCharArray())
                    .aliases()
                    .toList()
                    .singleOrNull() ?: error("$path must hold exactly one key")
            keyPassword = password
        }
    }
