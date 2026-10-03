package com.lionreader.app.ui

import android.content.Context
import android.provider.Settings
import androidx.compose.ui.MotionDurationScale

/**
 * How fast every Compose animation in the app runs: the system's animation scale, or none at all
 * when the settings turn animations off ([com.lionreader.shared.settings.AppSettings.animations]).
 * Given to the window's recomposer (MainActivity), which otherwise reads the system's scale itself;
 * with no animations, each one jumps straight to its end. So animations go off app-wide, not one by
 * one: only what this scale doesn't reach checks the setting itself (the screen transitions, whose
 * predictive back follows the finger; the article pager's fling snap; the reader's scroll to the
 * narrated paragraph).
 */
class AppMotion(private val context: Context) : MotionDurationScale {
    var enabled = true
    private var system = readSystemScale()

    override val scaleFactor: Float
        get() = if (enabled) system else 0f

    /** The system's scale, which can change while the app is in the background. */
    fun refresh() {
        system = readSystemScale()
    }

    private fun readSystemScale(): Float =
        Settings.Global.getFloat(
            context.contentResolver,
            Settings.Global.ANIMATOR_DURATION_SCALE,
            1f,
        )
}
