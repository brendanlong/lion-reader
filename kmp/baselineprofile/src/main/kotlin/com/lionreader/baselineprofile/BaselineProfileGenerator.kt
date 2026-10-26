package com.lionreader.baselineprofile

import androidx.benchmark.macro.junit4.BaselineProfileRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.Until
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The app's baseline profile: what to compile ahead of time, so the first launch and first article
 * after an install or update don't run slowly while the JIT catches up. Drives the debug app, which
 * must be signed in with articles on the device (Android 14+): `./gradlew
 * :androidApp:generateBaselineProfile` with it connected.
 */
@RunWith(AndroidJUnit4::class)
class BaselineProfileGenerator {
    @get:Rule val rule = BaselineProfileRule()

    @Test
    fun openArticles() =
        rule.collect(packageName = "com.lionreader.app.debug", includeInStartupProfile = true) {
            pressHome()
            startActivityAndWait()

            val list = device.wait(Until.findObject(By.scrollable(true)), TIMEOUT_MS)
            checkNotNull(list) { "No article list: sign the debug app in, with articles synced" }
            list.findObject(By.clickable(true)).click()
            check(device.wait(Until.hasObject(By.clazz(WEB_VIEW)), TIMEOUT_MS)) {
                "The article didn't open"
            }
            device.waitForIdle()

            // To the next article and back, as reading does.
            device.findObject(By.clazz(WEB_VIEW)).swipe(Direction.LEFT, 0.8f)
            device.waitForIdle()
            device.pressBack()
            device
                .wait(Until.findObject(By.scrollable(true)), TIMEOUT_MS)
                ?.scroll(Direction.DOWN, 1f)
            device.waitForIdle()
        }

    private companion object {
        const val TIMEOUT_MS = 10_000L
        const val WEB_VIEW = "android.webkit.WebView"
    }
}
