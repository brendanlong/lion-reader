package com.lionreader.ui.components

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.unit.dp
import com.lionreader.ui.theme.ShimmerBaseDark
import com.lionreader.ui.theme.ShimmerBaseLight
import com.lionreader.ui.theme.ShimmerHighlightDark
import com.lionreader.ui.theme.ShimmerHighlightLight

/**
 * A shimmer effect modifier for loading placeholders.
 *
 * Creates an animated gradient that moves across the element to indicate
 * content is loading. The shimmer automatically adapts to light and dark themes.
 *
 * @param shape The shape of the shimmer placeholder
 * @return A modifier with the shimmer effect applied
 */
@Composable
fun Modifier.shimmerEffect(shape: Shape = RoundedCornerShape(4.dp)): Modifier {
    val isDarkTheme = isSystemInDarkTheme()

    val baseColor = if (isDarkTheme) ShimmerBaseDark else ShimmerBaseLight
    val highlightColor = if (isDarkTheme) ShimmerHighlightDark else ShimmerHighlightLight

    val transition = rememberInfiniteTransition(label = "shimmer")
    val translateAnim by transition.animateFloat(
        initialValue = 0f,
        targetValue = 1000f,
        animationSpec =
            infiniteRepeatable(
                animation =
                    tween(
                        durationMillis = 1200,
                        easing = LinearEasing,
                    ),
                repeatMode = RepeatMode.Restart,
            ),
        label = "shimmer_translate",
    )

    val shimmerBrush =
        Brush.linearGradient(
            colors =
                listOf(
                    baseColor,
                    highlightColor,
                    baseColor,
                ),
            start = Offset(translateAnim - 200f, translateAnim - 200f),
            end = Offset(translateAnim, translateAnim),
        )

    return this
        .clip(shape)
        .background(shimmerBrush)
}

/**
 * A rectangular shimmer placeholder.
 *
 * Use this for text lines, buttons, or other rectangular content.
 *
 * @param modifier Modifier for size and positioning
 * @param shape The shape of the placeholder
 */
@Composable
fun ShimmerBox(
    modifier: Modifier = Modifier,
    shape: Shape = RoundedCornerShape(4.dp),
) {
    Box(
        modifier = modifier.shimmerEffect(shape),
    )
}

/**
 * A circular shimmer placeholder.
 *
 * Use this for avatars, icons, or circular loading indicators.
 *
 * @param modifier Modifier for size and positioning
 */
@Composable
fun ShimmerCircle(modifier: Modifier = Modifier) {
    Box(
        modifier = modifier.shimmerEffect(RoundedCornerShape(percent = 50)),
    )
}

/**
 * A spacer with shimmer effect for text line placeholders.
 *
 * @param modifier Modifier for size and positioning
 * @param shape The shape of the placeholder
 */
@Composable
fun ShimmerLine(
    modifier: Modifier = Modifier,
    shape: Shape = RoundedCornerShape(4.dp),
) {
    Spacer(
        modifier = modifier.shimmerEffect(shape),
    )
}
