package com.lionreader.app.ui

import androidx.compose.foundation.gestures.ScrollableState
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.semantics.pageDown
import androidx.compose.ui.semantics.pageUp
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import kotlin.math.abs
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/** Turns the pages of a scrolling list or page, [PAGE_FRACTION] of its height at a time. */
class PageTurner
internal constructor(
    private val state: ScrollableState,
    private val scope: CoroutineScope,
    onPastTop: State<() -> Unit>,
) {
    internal var height = 0
    private val onPastTop by onPastTop

    /** Down the page (1) or up it (-1), at once; false before it's laid out. */
    fun turn(direction: Int): Boolean {
        if (height == 0) return false
        scope.launch { state.scrollBy(direction * height * PAGE_FRACTION) }
        return true
    }

    /** A swipe: up the page from the top is [onPastTop] instead (the list's refresh). */
    internal fun swiped(direction: Int, far: Boolean) {
        if (direction < 0 && !state.canScrollBackward) {
            if (far) onPastTop()
        } else {
            turn(direction)
        }
    }
}

/**
 * A [PageTurner] for [state], which the volume buttons turn ([PageTurns]) while [active]. Pair it
 * with [pageSwipes] on the scrolling container. [onPastTop]: a long swipe down with nothing above
 * (the list's refresh, which page mode's lack of scrolling would otherwise lose).
 */
@Composable
fun rememberPageTurner(
    state: ScrollableState,
    pageTurns: PageTurns,
    layer: PageLayer,
    active: Boolean = true,
    onPastTop: () -> Unit = {},
): PageTurner {
    val scope = rememberCoroutineScope()
    val pastTop = rememberUpdatedState(onPastTop)
    val turner = remember(state) { PageTurner(state, scope, pastTop) }
    if (active) {
        DisposableEffect(turner, pageTurns, layer) {
            val unregister = pageTurns.register(layer, turner::turn)
            onDispose { unregister() }
        }
    }
    return turner
}

/**
 * Measures the page for [turner], and with [enabled] (page mode, for e-readers; give the container
 * `userScrollEnabled = false`) has a swipe up or down turn the page rather than scroll with the
 * finger, and offers page up and down to accessibility services in place of the scroll actions the
 * container no longer has.
 */
fun Modifier.pageSwipes(turner: PageTurner, enabled: Boolean): Modifier {
    val sized = onSizeChanged { turner.height = it.height }
    if (!enabled) return sized
    return sized
        .semantics {
            pageDown { turner.turn(1) }
            pageUp { turner.turn(-1) }
        }
        .pointerInput(turner) {
            // A refresh wants a pull as deliberate as pull-to-refresh's.
            val pull = 80.dp.toPx()
            var dragged = 0f
            detectVerticalDragGestures(
                onDragStart = { dragged = 0f },
                onDragEnd = {
                    // A finger moving up moves down the page.
                    if (dragged != 0f)
                        turner.swiped(if (dragged < 0) 1 else -1, abs(dragged) > pull)
                },
            ) { change, delta ->
                change.consume()
                dragged += delta
            }
        }
}
