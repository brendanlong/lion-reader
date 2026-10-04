package com.lionreader.app.ui

import android.view.ViewConfiguration
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ScrollIndicatorState
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.drop

/**
 * A vertical scrollbar at the end edge, shown each time [indicator]'s offset moves (a drag, a
 * fling, a page turn) and faded out after, on Android's own scrollbars' timing. Only drawn: it
 * takes no touches.
 */
@Composable
fun Modifier.scrollbar(indicator: () -> ScrollIndicatorState?): Modifier {
    val current by rememberUpdatedState(indicator)
    val alpha = remember { Animatable(0f) }
    LaunchedEffect(Unit) {
        snapshotFlow { current()?.scrollOffset }
            // Not for where it starts.
            .drop(1)
            .collectLatest {
                alpha.snapTo(1f)
                delay(ViewConfiguration.getScrollDefaultDelay().toLong())
                alpha.animateTo(0f, tween(ViewConfiguration.getScrollBarFadeDuration()))
            }
    }
    val color = MaterialTheme.colorScheme.onSurface.copy(alpha = THUMB_ALPHA)
    return drawWithContent {
        drawContent()
        val shown = alpha.value
        val state = indicator() ?: return@drawWithContent
        if (shown == 0f) return@drawWithContent
        val thumb =
            thumbSpan(
                state.scrollOffset,
                state.contentSize,
                state.viewportSize,
                size.height,
                MIN_THUMB_LENGTH.toPx(),
            ) ?: return@drawWithContent
        val width = THUMB_WIDTH.toPx()
        drawRoundRect(
            color = color,
            topLeft = Offset(size.width - width - EDGE_GAP.toPx(), thumb.start),
            size = Size(width, thumb.length),
            cornerRadius = CornerRadius(width / 2),
            alpha = shown,
        )
    }
}

internal data class ThumbSpan(val start: Float, val length: Float)

/**
 * Where a scrollbar's thumb goes along a [track] of pixels; null with nothing to scroll. A thumb
 * held at [minLength] still spans the track, top to bottom.
 */
internal fun thumbSpan(
    offset: Int,
    content: Int,
    viewport: Int,
    track: Float,
    minLength: Float,
): ThumbSpan? {
    if (viewport <= 0 || content <= viewport) return null
    val length = maxOf(track * viewport / content, minLength).coerceAtMost(track)
    val start = (track - length) * offset.coerceIn(0, content - viewport) / (content - viewport)
    return ThumbSpan(start, length)
}

/**
 * [state]'s position in a list of [total] rows, of which only the first ones are loaded: its
 * [LazyListState.scrollIndicatorState] would take the loaded rows for the whole list. Rows not laid
 * out are taken to be the average height of those that are.
 */
internal class LongListIndicator(
    private val state: LazyListState,
    private val total: () -> Long,
) : ScrollIndicatorState {
    private val rowHeight: Float
        get() {
            val visible = state.layoutInfo.visibleItemsInfo
            if (visible.isEmpty()) return 0f
            return visible.sumOf { it.size }.toFloat() / visible.size
        }

    private val rows: Long
        get() = maxOf(total(), state.layoutInfo.totalItemsCount.toLong())

    override val viewportSize: Int
        get() = state.layoutInfo.let { it.viewportEndOffset - it.viewportStartOffset }

    override val contentSize: Int
        get() = (rows * rowHeight).toInt()

    // At the end, this is exactly contentSize - viewportSize: the rows on screen then fill the
    // viewport plus the first one's hidden part, at rowHeight each.
    override val scrollOffset: Int
        get() =
            (state.firstVisibleItemIndex * rowHeight + state.firstVisibleItemScrollOffset).toInt()
}

private const val THUMB_ALPHA = 0.4f
private val THUMB_WIDTH = 4.dp
private val EDGE_GAP = 2.dp
private val MIN_THUMB_LENGTH = 32.dp
