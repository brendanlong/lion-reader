import io.gitlab.arturbosch.detekt.Detekt
import java.io.FileInputStream
import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
    alias(libs.plugins.hilt)
    alias(libs.plugins.ktlint)
    alias(libs.plugins.detekt)
}

// Load local.properties if exists (for keystore configuration)
val localPropertiesFile = rootProject.file("local.properties")
val localProperties = Properties()
if (localPropertiesFile.exists()) {
    localProperties.load(FileInputStream(localPropertiesFile))
}

// Version configuration
val versionMajor = 1
val versionMinor = 0
val versionPatch = 0
val versionBuild = 1 // Increment for each build

android {
    namespace = "com.lionreader"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.lionreader"
        minSdk = 26
        targetSdk = 34
        versionCode = versionMajor * 10000 + versionMinor * 1000 + versionPatch * 100 + versionBuild
        versionName = "$versionMajor.$versionMinor.$versionPatch"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        // API configuration - can be overridden per build type
        buildConfigField("String", "API_BASE_URL", "\"https://lion-reader.fly.dev\"")
        buildConfigField("String", "API_BASE_PATH", "\"/api/v1\"")
        buildConfigField("boolean", "LOGGING_ENABLED", "false")
    }

    signingConfigs {
        // Debug signing config - uses default debug keystore
        getByName("debug") {
            // Uses default debug keystore automatically
        }

        // Release signing config - reads from environment variables or local.properties
        create("release") {
            // Priority: Environment variables > local.properties
            val keystorePath = System.getenv("LION_READER_KEYSTORE_PATH")
                ?: localProperties.getProperty("LION_READER_KEYSTORE_PATH")
            val keystorePassword = System.getenv("LION_READER_KEYSTORE_PASSWORD")
                ?: localProperties.getProperty("LION_READER_KEYSTORE_PASSWORD")
            val keyAliasValue = System.getenv("LION_READER_KEY_ALIAS")
                ?: localProperties.getProperty("LION_READER_KEY_ALIAS")
            val keyPasswordValue = System.getenv("LION_READER_KEY_PASSWORD")
                ?: localProperties.getProperty("LION_READER_KEY_PASSWORD")

            if (keystorePath != null && keystorePassword != null &&
                keyAliasValue != null && keyPasswordValue != null
            ) {
                storeFile = file(keystorePath)
                storePassword = keystorePassword
                keyAlias = keyAliasValue
                keyPassword = keyPasswordValue
            }
        }
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
            isShrinkResources = false
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"

            // Debug-specific configuration
            buildConfigField("String", "API_BASE_URL", "\"https://lion-reader.fly.dev\"")
            buildConfigField("boolean", "LOGGING_ENABLED", "true")

            // Debug uses default debug signing
            signingConfig = signingConfigs.getByName("debug")
        }

        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )

            // Release-specific configuration
            buildConfigField("String", "API_BASE_URL", "\"https://lion-reader.fly.dev\"")
            buildConfigField("boolean", "LOGGING_ENABLED", "false")

            // Release signing - only applied if keystore is configured
            val releaseSigningConfig = signingConfigs.findByName("release")
            if (releaseSigningConfig?.storeFile != null) {
                signingConfig = releaseSigningConfig
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

// ktlint configuration
ktlint {
    version.set("1.4.1")
    android.set(true)
    outputColorName.set("RED")
    reporters {
        reporter(org.jlleitschuh.gradle.ktlint.reporter.ReporterType.PLAIN)
        reporter(org.jlleitschuh.gradle.ktlint.reporter.ReporterType.CHECKSTYLE)
    }
}

// detekt configuration
detekt {
    buildUponDefaultConfig = true
    allRules = false
    config.setFrom("$projectDir/config/detekt/detekt.yml")
    baseline = file("$projectDir/config/detekt/baseline.xml")
}

tasks.withType<Detekt>().configureEach {
    jvmTarget = "17"
    reports {
        html.required.set(true)
        xml.required.set(true)
        txt.required.set(false)
        sarif.required.set(false)
    }
}

// Enable JUnit 5 for unit tests
tasks.withType<Test> {
    useJUnitPlatform()
}

dependencies {
    // Core Android
    implementation(libs.androidx.core.ktx)

    // Compose
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.ui)
    implementation(libs.androidx.ui.graphics)
    implementation(libs.androidx.ui.tooling.preview)
    implementation(libs.androidx.material3)

    // Compose Navigation
    implementation(libs.androidx.navigation.compose)

    // Lifecycle
    implementation(libs.bundles.lifecycle)

    // Coroutines
    implementation(libs.bundles.coroutines)

    // Kotlin Serialization
    implementation(libs.kotlinx.serialization.json)

    // Room
    implementation(libs.bundles.room)
    ksp(libs.room.compiler)

    // Ktor Client
    implementation(libs.bundles.ktor)

    // DataStore
    implementation(libs.datastore.preferences)

    // Coil (Image Loading)
    implementation(libs.coil.compose)

    // Security
    implementation(libs.security.crypto)

    // WorkManager
    implementation(libs.work.runtime.ktx)
    implementation(libs.hilt.work)
    ksp(libs.hilt.work.compiler)

    // Hilt
    implementation(libs.hilt.android)
    ksp(libs.hilt.compiler)
    implementation(libs.hilt.navigation.compose)

    // Unit Testing
    testImplementation(libs.bundles.junit5)
    testRuntimeOnly(libs.junit5.engine)
    testImplementation(libs.kotlin.test)
    testImplementation(libs.kotlin.test.junit5)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.turbine)
    testImplementation(libs.mockk)
    testImplementation(libs.room.testing)

    // Android Instrumented Testing
    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.espresso.core)
    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(libs.androidx.ui.test.junit4)
    androidTestImplementation(libs.hilt.android.testing)
    kspAndroidTest(libs.hilt.compiler)
    androidTestImplementation(libs.mockk.android)
    androidTestImplementation(libs.work.testing)
    androidTestImplementation(libs.ktor.client.mock)

    // Debug
    debugImplementation(libs.androidx.ui.tooling)
    debugImplementation(libs.androidx.ui.test.manifest)
}
