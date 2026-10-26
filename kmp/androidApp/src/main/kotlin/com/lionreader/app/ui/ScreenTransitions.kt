package com.lionreader.app.ui

import androidx.compose.animation.ContentTransform
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally

private const val DURATION_MS = 300

/** How screen changes move. */
internal fun <T> screenChangeSpec() = tween<T>(DURATION_MS, easing = FastOutSlowInEasing)

/** How far a screen drifts left (of its width) as another slides in over it. */
internal const val COVERED_DRIFT = 0.25f

/**
 * Android's usual screen change: a new screen slides in from the right over the old one, which
 * drifts a little left; going back (including the predictive back gesture, which follows the
 * finger) reverses it. None when the settings turn animations off.
 */
class ScreenTransitions(private val animate: Boolean) {

    val forward: ContentTransform =
        if (!animate) none()
        else
            ContentTransform(
                targetContentEnter = slideInHorizontally(screenChangeSpec()) { it },
                initialContentExit =
                    slideOutHorizontally(screenChangeSpec()) { -(it * COVERED_DRIFT).toInt() },
            )

    val back: ContentTransform =
        if (!animate) none()
        else
            ContentTransform(
                targetContentEnter =
                    slideInHorizontally(screenChangeSpec()) { -(it * COVERED_DRIFT).toInt() },
                initialContentExit = slideOutHorizontally(screenChangeSpec()) { it },
                // The screen being left slides away on top of the one revealed.
                targetContentZIndex = -1f,
            )

    private fun none() = ContentTransform(EnterTransition.None, ExitTransition.None)
}
