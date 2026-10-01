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

    // iOS goes here (iosArm64(), iosSimulatorArm64()) once there is a macOS
    // runner to link on; the default hierarchy template then gives iosMain.

    sourceSets {
        commonMain.dependencies {
            implementation(libs.kotlinx.coroutines.core)
            implementation(libs.kotlinx.serialization.json)
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

// RealServerTest reads its fixture from the environment; make it a task input
// so a new fixture reruns the test instead of hitting the build cache.
tasks.named<Test>("jvmTest") {
    inputs.property(
        "realServerFixture",
        providers.environmentVariable("LION_READER_TEST_FIXTURE").orElse(""),
    )
}
