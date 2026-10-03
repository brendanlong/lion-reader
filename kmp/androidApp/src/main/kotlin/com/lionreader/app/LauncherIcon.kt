package com.lionreader.app

import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build

/**
 * Shows the e-ink icon in the launcher on an e-ink device, and the color one elsewhere. Android has
 * no resource qualifier for e-ink, so the manifest has a launcher entry per icon and this enables
 * one. Elsewhere it leaves both as the manifest has them, so only an e-ink device's first launch
 * after install changes anything; that drops shortcuts pinned to the color entry.
 */
fun Context.useLauncherIcon(eink: Boolean = isEinkDevice()) {
    val shown = shownIcon(eink)
    // Enable the new entry first, so there's never a moment with neither.
    for (alias in listOf(shown) + (ICONS - shown)) {
        val component = ComponentName(this, alias)
        val state =
            when {
                !eink -> PackageManager.COMPONENT_ENABLED_STATE_DEFAULT
                alias == shown -> PackageManager.COMPONENT_ENABLED_STATE_ENABLED
                else -> PackageManager.COMPONENT_ENABLED_STATE_DISABLED
            }
        if (packageManager.getComponentEnabledSetting(component) != state) {
            packageManager.setComponentEnabledSetting(
                component,
                state,
                PackageManager.DONT_KILL_APP,
            )
        }
    }
}

/**
 * Android removes a task started from a launcher entry once that entry is disabled, DONT_KILL_APP
 * or not, so the launch that swaps the icon would close a second after it opens. Instead an
 * activity started from the hidden entry reopens itself, in a new task, from the shown one. Returns
 * whether it did, in which case this activity is finishing.
 */
fun Activity.reopenFromShownIcon(eink: Boolean = isEinkDevice()): Boolean {
    val launchedFrom = intent.component?.className ?: return false
    val shown = shownIcon(eink)
    if (launchedFrom !in ICONS || launchedFrom == shown) return false
    finishAndRemoveTask()
    startActivity(
        intent.setComponent(ComponentName(this, shown)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    )
    return true
}

private fun isEinkDevice(): Boolean =
    isEinkDevice(Build.MANUFACTURER.orEmpty(), Build.BRAND.orEmpty())

private fun shownIcon(eink: Boolean): String = if (eink) EINK_ICON else COLOR_ICON

// Named from the namespace, which debug builds' application id doesn't change.
internal const val COLOR_ICON = "com.lionreader.app.ColorIcon"
internal const val EINK_ICON = "com.lionreader.app.EinkIcon"
private val ICONS = listOf(COLOR_ICON, EINK_ICON)
