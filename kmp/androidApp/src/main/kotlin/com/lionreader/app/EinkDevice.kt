package com.lionreader.app

import android.os.Build

/**
 * Makers whose Android devices are e-readers with e-ink screens. Android can't tell an app its
 * screen is e-ink, so this goes by who made the device: Onyx (Boox), Boyue (Likebook, Meebook),
 * Bigme and Mudita. A maker that also makes ordinary screens can't be told apart this way, and
 * isn't listed.
 */
private val EINK_MAKERS = setOf("onyx", "boox", "boyue", "likebook", "meebook", "bigme", "mudita")

fun isEinkDevice(manufacturer: String, brand: String): Boolean =
    listOf(manufacturer, brand).any { it.trim().lowercase() in EINK_MAKERS }

/**
 * The settings a device starts with: on an e-ink one, the E-paper theme and no animations, which
 * the user can still change.
 */
fun deviceDefaults(
    eink: Boolean = isEinkDevice(Build.MANUFACTURER.orEmpty(), Build.BRAND.orEmpty())
): AppSettings =
    if (eink) AppSettings(theme = ThemeChoice.EPAPER, animations = false) else AppSettings()
