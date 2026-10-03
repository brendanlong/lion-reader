package com.lionreader.app

import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build

/**
 * Shows the e-ink icon in the launcher on an e-ink device, and the color one elsewhere. Android has
 * no resource qualifier for e-ink, so the manifest has a launcher entry per icon and this enables
 * one. Swapping drops shortcuts pinned to the old entry, which only happens on the first launch
 * after install.
 */
fun Context.useLauncherIcon(
    eink: Boolean = isEinkDevice(Build.MANUFACTURER.orEmpty(), Build.BRAND.orEmpty())
) {
    val shown = if (eink) EINK_ICON else COLOR_ICON
    // Enable the new entry first, so there's never a moment with neither.
    for (alias in listOf(shown) + (ICONS - shown)) {
        val component = ComponentName(this, alias)
        val state =
            if (alias == shown) PackageManager.COMPONENT_ENABLED_STATE_ENABLED
            else PackageManager.COMPONENT_ENABLED_STATE_DISABLED
        if (packageManager.getComponentEnabledSetting(component) != state) {
            packageManager.setComponentEnabledSetting(
                component,
                state,
                PackageManager.DONT_KILL_APP,
            )
        }
    }
}

// Named from the namespace, which debug builds' application id doesn't change.
internal const val COLOR_ICON = "com.lionreader.app.ColorIcon"
internal const val EINK_ICON = "com.lionreader.app.EinkIcon"
private val ICONS = listOf(COLOR_ICON, EINK_ICON)
