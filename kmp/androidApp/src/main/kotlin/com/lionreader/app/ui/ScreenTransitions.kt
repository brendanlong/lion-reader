package com.lionreader.app.ui

import androidx.compose.animation.ContentTransform
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import com.lionreader.app.ThemeChoice

private const val DURATION_MS = 300

/**
 * Android's usual screen change: a new screen slides in from the right over the old one, which
 * drifts a little left; going back (including the predictive back gesture, which follows the
 * finger) reverses it. None on e-paper, where animation only smears.
 */
class ScreenTransitions(theme: ThemeChoice) {
    private val animate = theme != ThemeChoice.EPAPER

    private fun <T> spec() = tween<T>(DURATION_MS, easing = FastOutSlowInEasing)

    val forward: ContentTransform =
        if (!animate) none()
        else
            ContentTransform(
                targetContentEnter = slideInHorizontally(spec()) { it },
                initialContentExit = slideOutHorizontally(spec()) { -it / 4 },
            )

    val back: ContentTransform =
        if (!animate) none()
        else
            ContentTransform(
                targetContentEnter = slideInHorizontally(spec()) { -it / 4 },
                initialContentExit = slideOutHorizontally(spec()) { it },
                // The screen being left slides away on top of the one revealed.
                targetContentZIndex = -1f,
            )

    private fun none() = ContentTransform(EnterTransition.None, ExitTransition.None)
}
