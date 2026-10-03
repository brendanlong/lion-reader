package com.lionreader.app

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager.COMPONENT_ENABLED_STATE_DISABLED
import android.content.pm.PackageManager.COMPONENT_ENABLED_STATE_ENABLED
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class LauncherIconTest {
    private val context: Context = ApplicationProvider.getApplicationContext()

    private fun state(alias: String) =
        context.packageManager.getComponentEnabledSetting(ComponentName(context, alias))

    @Test
    fun anEinkDeviceShowsOnlyTheEinkIcon() {
        context.useLauncherIcon(eink = true)
        assertEquals(COMPONENT_ENABLED_STATE_ENABLED, state(EINK_ICON))
        assertEquals(COMPONENT_ENABLED_STATE_DISABLED, state(COLOR_ICON))
    }

    @Test
    fun otherDevicesShowOnlyTheColorIcon() {
        context.useLauncherIcon(eink = true)
        context.useLauncherIcon(eink = false)
        assertEquals(COMPONENT_ENABLED_STATE_ENABLED, state(COLOR_ICON))
        assertEquals(COMPONENT_ENABLED_STATE_DISABLED, state(EINK_ICON))
    }

    @Test
    fun theLauncherFindsTheShownIcon() {
        context.useLauncherIcon(eink = true)
        val launchers =
            context.packageManager.queryIntentActivities(
                android.content
                    .Intent(Intent.ACTION_MAIN)
                    .addCategory(Intent.CATEGORY_LAUNCHER)
                    .setPackage(context.packageName),
                0,
            )
        assertEquals(listOf(EINK_ICON), launchers.map { it.activityInfo.name })
    }
}
