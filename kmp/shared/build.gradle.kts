plugins {
    alias(libs.plugins.kotlin.multiplatform)
    alias(libs.plugins.android.kotlin.multiplatform.library)
    alias(libs.plugins.android.lint)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.sqldelight)
}

kotlin {
    jvmToolchain(libs.versions.jdk.get().toInt())

    // Fast tests and the real-server integration suite run on the JVM target.
    jvm()

    android {
        namespace = "com.lionreader.shared"
        compileSdk = libs.versions.androidCompileSdk.get().toInt()
        minSdk = libs.versions.androidMinSdk.get().toInt()

        // Runs commonTest against the Android target too (on the host JVM).
        withHostTest {}

        lint {
            lintConfig = rootProject.file("lint.xml")
            warningsAsErrors = true
            abortOnError = true
        }
    }

    // Compiled (not linked: that needs macOS) on every host, so `check` catches
    // JVM-only code in commonMain.
    iosArm64()
    iosSimulatorArm64()

    sourceSets {
        commonMain.dependencies {
            implementation(libs.kotlinx.coroutines.core)
            implementation(libs.kotlinx.serialization.json)
            implementation(libs.okio)
            api(libs.androidx.datastore.preferences.core)
            api(libs.androidx.lifecycle.viewmodel)
            api(libs.ktor.client.core)
            api(libs.sqldelight.coroutines)
        }
        commonTest.dependencies {
            implementation(kotlin("test"))
            implementation(libs.kotlinx.coroutines.test)
        }
        androidMain.dependencies {
            implementation(libs.ktor.client.okhttp)
            implementation(libs.sqldelight.android.driver)
        }
        jvmMain.dependencies {
            implementation(libs.ktor.client.okhttp)
            implementation(libs.sqldelight.sqlite.driver)
        }
        jvmTest.dependencies { implementation(libs.ktor.client.mock) }
    }
}

sqldelight {
    databases {
        create("LionReaderDatabase") {
            packageName.set("com.lionreader.shared.db")
            // Each released schema (N.db, generated with
            // generateCommonMainLionReaderDatabaseSchema) is checked against
            // the migrations that start from it.
            schemaOutputDirectory.set(file("src/commonMain/sqldelight/databases"))
            verifyMigrations.set(true)
        }
    }
}

tasks.named("check") {
    dependsOn("compileKotlinIosArm64", "compileKotlinIosSimulatorArm64")
}

// RealServerTest reads its fixture from the environment; make it a task input
// so a new fixture reruns the test instead of hitting the build cache.
tasks.named<Test>("jvmTest") {
    inputs.property(
        "realServerFixture",
        providers.environmentVariable("LION_READER_TEST_FIXTURE").orElse(""),
    )
}
