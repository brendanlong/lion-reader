plugins {
    alias(libs.plugins.android.test)
    alias(libs.plugins.androidx.baselineprofile)
}

kotlin { jvmToolchain(libs.versions.jdk.get().toInt()) }

android {
    namespace = "com.lionreader.baselineprofile"
    compileSdk = libs.versions.androidCompileSdk.get().toInt()

    defaultConfig {
        // Before Android 14, Macrobenchmark resets the app's compiled code by reinstalling it,
        // which signs it out.
        minSdk = 34
        targetSdk = libs.versions.androidTargetSdk.get().toInt()
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    targetProjectPath = ":androidApp"
}

// The phone the developer has signed in on, not an emulator (see BaselineProfileGenerator).
baselineProfile { useConnectedDevices = true }

dependencies {
    implementation(libs.androidx.test.ext.junit)
    implementation(libs.androidx.benchmark.macro.junit4)
    implementation(libs.androidx.test.uiautomator)
}
