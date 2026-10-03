package com.lionreader.app

import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager.COMPONENT_ENABLED_STATE_DEFAULT
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.Shadows.shadowOf

@RunWith(AndroidJUnit4::class)
class LauncherIconTest {
    private val context: Context = ApplicationProvider.getApplicationContext()

    private fun launcherEntries(): List<String> =
        context.packageManager
            .queryIntentActivities(
                Intent(Intent.ACTION_MAIN)
                    .addCategory(Intent.CATEGORY_LAUNCHER)
                    .setPackage(context.packageName),
                0,
            )
            .map { it.activityInfo.name }

    private fun state(alias: String) =
        context.packageManager.getComponentEnabledSetting(ComponentName(context, alias))

    @Test
    fun anEinkDeviceShowsOnlyTheEinkIcon() {
        context.useLauncherIcon(eink = true)
        assertEquals(listOf(EINK_ICON), launcherEntries())
    }

    @Test
    fun otherDevicesShowOnlyTheColorIcon() {
        context.useLauncherIcon(eink = false)
        assertEquals(listOf(COLOR_ICON), launcherEntries())
    }

    @Test
    fun otherDevicesLeaveTheManifestAlone() {
        context.useLauncherIcon(eink = true)
        context.useLauncherIcon(eink = false)
        assertEquals(listOf(COLOR_ICON), launcherEntries())
        assertEquals(COMPONENT_ENABLED_STATE_DEFAULT, state(COLOR_ICON))
        assertEquals(COMPONENT_ENABLED_STATE_DEFAULT, state(EINK_ICON))
    }

    private fun launchedFrom(alias: String): Activity =
        Robolectric.buildActivity(
                Activity::class.java,
                Intent(Intent.ACTION_MAIN)
                    .addCategory(Intent.CATEGORY_LAUNCHER)
                    .setComponent(ComponentName(context, alias)),
            )
            .create()
            .get()

    @Test
    fun aLaunchFromTheHiddenIconReopensFromTheShownOne() {
        val activity = launchedFrom(COLOR_ICON)
        assertTrue(activity.reopenFromShownIcon(eink = true))
        assertTrue(activity.isFinishing)
        val reopened = shadowOf(activity).nextStartedActivity
        assertEquals(ComponentName(context, EINK_ICON), reopened.component)
        assertEquals(Intent.ACTION_MAIN, reopened.action)
        assertTrue(reopened.flags and Intent.FLAG_ACTIVITY_NEW_TASK != 0)
    }

    @Test
    fun aLaunchFromTheShownIconStays() {
        val activity = launchedFrom(EINK_ICON)
        assertFalse(activity.reopenFromShownIcon(eink = true))
        assertFalse(activity.isFinishing)
        assertNull(shadowOf(activity).nextStartedActivity)
    }

    @Test
    fun aLaunchNotFromALauncherEntryStays() {
        val activity = launchedFrom("com.lionreader.app.MainActivity")
        assertFalse(activity.reopenFromShownIcon(eink = true))
        assertNull(shadowOf(activity).nextStartedActivity)
    }
}
