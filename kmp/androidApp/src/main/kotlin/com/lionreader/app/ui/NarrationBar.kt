package com.lionreader.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import com.lionreader.app.R
import com.lionreader.app.narration.NarrationState
import java.text.NumberFormat
import kotlinx.coroutines.delay

val NARRATION_SPEEDS = listOf(0.75f, 1f, 1.25f, 1.5f, 1.75f, 2f)

fun speedLabel(speed: Float): String = "${shortNumber(speed)}×"

/** "1", "0.25" (or "0,25"), in the user's locale. */
fun shortNumber(value: Float): String =
    NumberFormat.getNumberInstance().apply { maximumFractionDigits = 2 }.format(value)

/**
 * Narration controls: previous/next paragraph, play/pause and speed. Narration is always of the
 * article on screen, so the bar doesn't name it. The Listen toggle turns narration off. The host
 * draws the surface and the navigation bar inset, so other bars can share them.
 */
@Composable
fun NarrationBar(
    state: NarrationState,
    speed: Float,
    onPrevious: () -> Unit,
    onToggle: () -> Unit,
    onNext: () -> Unit,
    onSpeed: (Float) -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceEvenly,
    ) {
        IconButton(onClick = onPrevious) {
            Icon(painterResource(R.drawable.ic_skip_previous), "Previous paragraph")
        }
        // Only waits long enough to notice: every seek buffers for a moment.
        var loading by remember { mutableStateOf(false) }
        LaunchedEffect(state.playing && state.waiting) {
            loading = false
            if (state.playing && state.waiting) {
                delay(300)
                loading = true
            }
        }
        IconButton(
            onClick = onToggle,
            modifier = Modifier.semantics { if (loading) stateDescription = "Loading" },
        ) {
            if (loading) {
                // Tapping still pauses; the spinner says audio is on its way.
                CircularProgressIndicator(
                    modifier = Modifier.size(24.dp).semantics { contentDescription = "Pause" },
                    strokeWidth = 2.5.dp,
                )
            } else {
                Icon(
                    painterResource(if (state.playing) R.drawable.ic_pause else R.drawable.ic_play),
                    if (state.playing) "Pause" else "Play",
                )
            }
        }
        IconButton(onClick = onNext) {
            Icon(painterResource(R.drawable.ic_skip_next), "Next paragraph")
        }
        TextButton(
            onClick = {
                val next = NARRATION_SPEEDS.firstOrNull { it > speed + 0.01f }
                onSpeed(next ?: NARRATION_SPEEDS.first())
            },
            // "1×" alone doesn't say what it is.
            modifier =
                Modifier.semantics { contentDescription = "Narration speed: ${speedLabel(speed)}" },
        ) {
            Text(speedLabel(speed), Modifier.clearAndSetSemantics {})
        }
    }
}
