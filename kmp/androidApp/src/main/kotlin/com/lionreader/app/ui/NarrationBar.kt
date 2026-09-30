package com.lionreader.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.lionreader.app.R
import com.lionreader.app.narration.NarrationState

val NARRATION_SPEEDS = listOf(0.75f, 1f, 1.25f, 1.5f, 1.75f, 2f)

fun speedLabel(speed: Float): String = "${"%.2f".format(speed).trimEnd('0').trimEnd('.')}×"

/** Narration controls: the article, previous/next paragraph, play/pause, speed, stop. */
@Composable
fun NarrationBar(
    state: NarrationState,
    speed: Float,
    onPrevious: () -> Unit,
    onToggle: () -> Unit,
    onNext: () -> Unit,
    onSpeed: (Float) -> Unit,
    onStop: () -> Unit,
) {
    Surface(tonalElevation = 3.dp) {
        Row(
            modifier = Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(
                state.title,
                style = MaterialTheme.typography.labelLarge,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f).padding(start = 8.dp),
            )
            IconButton(onClick = onPrevious) {
                Icon(painterResource(R.drawable.ic_skip_previous), "Previous paragraph")
            }
            IconButton(onClick = onToggle) {
                if (state.playing && state.waiting) {
                    // Tapping still pauses; the spinner says audio is on its way.
                    CircularProgressIndicator(
                        modifier =
                            Modifier.size(24.dp).semantics {
                                contentDescription = "Loading narration. Pause"
                            },
                        strokeWidth = 2.5.dp,
                    )
                } else {
                    Icon(
                        painterResource(
                            if (state.playing) R.drawable.ic_pause else R.drawable.ic_play
                        ),
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
                }
            ) {
                Text(speedLabel(speed))
            }
            IconButton(onClick = onStop) {
                Icon(painterResource(R.drawable.ic_close), "Stop narration")
            }
        }
    }
}
