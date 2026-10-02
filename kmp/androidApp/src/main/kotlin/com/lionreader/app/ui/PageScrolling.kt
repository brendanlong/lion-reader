package com.lionreader.app.ui

import androidx.compose.foundation.gestures.ScrollableState
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/** Turns the pages of a scrolling list or page, [PAGE_FRACTION] of its height at a time. */
class PageTurner
internal constructor(
    private val state: ScrollableState,
    private val scope: CoroutineScope,
) {
    internal var height = 0

    val atTop: Boolean
        get() = !state.canScrollBackward

    /** Down the page (1) or up it (-1), at once. */
    fun turn(direction: Int) {
        scope.launch { state.scrollBy(direction * height * PAGE_FRACTION) }
    }
}

/**
 * A [PageTurner] for [state], which the volume buttons turn ([PageTurns]) while [active]. Pair it
 * with [pageSwipes] on the scrolling container.
 */
@Composable
fun rememberPageTurner(
    state: ScrollableState,
    pageTurns: PageTurns,
    active: Boolean = true,
): PageTurner {
    val scope = rememberCoroutineScope()
    val turner = remember(state) { PageTurner(state, scope) }
    if (active) {
        DisposableEffect(turner, pageTurns) {
            val unregister = pageTurns.register(turner::turn)
            onDispose { unregister() }
        }
    }
    return turner
}

/**
 * Measures the page for [turner], and with [enabled] (page mode, for e-readers; give the container
 * `userScrollEnabled = false`) has a swipe up or down turn the page rather than scroll with the
 * finger. A swipe down with nothing above calls [onPastTop] (the list's refresh, which page mode's
 * lack of scrolling would otherwise lose).
 */
fun Modifier.pageSwipes(
    turner: PageTurner,
    enabled: Boolean,
    onPastTop: () -> Unit = {},
): Modifier {
    val sized = onSizeChanged { turner.height = it.height }
    if (!enabled) return sized
    return sized.pointerInput(turner) {
        var dragged = 0f
        detectVerticalDragGestures(
            onDragStart = { dragged = 0f },
            onDragEnd = {
                // A finger moving up moves down the page.
                val direction = if (dragged < 0) 1 else -1
                if (direction < 0 && turner.atTop) onPastTop() else turner.turn(direction)
            },
        ) { change, delta ->
            change.consume()
            dragged += delta
        }
    }
}
