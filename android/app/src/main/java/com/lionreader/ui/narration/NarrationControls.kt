package com.lionreader.ui.narration

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.SkipNext
import androidx.compose.material.icons.filled.SkipPrevious
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.lionreader.service.NarrationState

/**
 * Narration controls UI component.
 *
 * Displays playback controls that adapt to the current narration state:
 * - Idle: Play button
 * - Loading: Loading spinner
 * - Playing: Previous, Pause, Next buttons + paragraph counter
 * - Paused: Previous, Play, Next buttons + paragraph counter
 * - Error: Error icon, message, and Retry button
 *
 * @param narrationState Current state of the narration
 * @param onPlay Callback when play button is pressed (in Idle state)
 * @param onPause Callback when pause button is pressed
 * @param onResume Callback when resume/play button is pressed (in Paused state)
 * @param onSkipPrevious Callback when skip previous button is pressed
 * @param onSkipNext Callback when skip next button is pressed
 * @param onRetry Callback when retry button is pressed (in Error state)
 * @param modifier Modifier for the controls container
 */
@Composable
fun NarrationControls(
    narrationState: NarrationState,
    onPlay: () -> Unit,
    onPause: () -> Unit,
    onResume: () -> Unit,
    onSkipPrevious: () -> Unit,
    onSkipNext: () -> Unit,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Surface(
        modifier = modifier,
        tonalElevation = 2.dp,
        shadowElevation = 4.dp,
    ) {
        when (narrationState) {
            is NarrationState.Idle -> {
                IdleControls(
                    onPlay = onPlay,
                    modifier = Modifier.padding(16.dp),
                )
            }
            is NarrationState.Loading -> {
                LoadingControls(
                    modifier = Modifier.padding(16.dp),
                )
            }
            is NarrationState.Playing -> {
                PlayingControls(
                    currentParagraph = narrationState.currentParagraph,
                    totalParagraphs = narrationState.totalParagraphs,
                    onPause = onPause,
                    onSkipPrevious = onSkipPrevious,
                    onSkipNext = onSkipNext,
                    modifier = Modifier.padding(16.dp),
                )
            }
            is NarrationState.Paused -> {
                PausedControls(
                    currentParagraph = narrationState.currentParagraph,
                    totalParagraphs = narrationState.totalParagraphs,
                    onResume = onResume,
                    onSkipPrevious = onSkipPrevious,
                    onSkipNext = onSkipNext,
                    modifier = Modifier.padding(16.dp),
                )
            }
            is NarrationState.Error -> {
                ErrorControls(
                    errorMessage = narrationState.message,
                    onRetry = onRetry,
                    modifier = Modifier.padding(16.dp),
                )
            }
        }
    }
}

@Composable
private fun IdleControls(
    onPlay: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton(onClick = onPlay) {
            Icon(
                imageVector = Icons.Default.PlayArrow,
                contentDescription = "Play narration",
                modifier = Modifier.size(32.dp),
            )
        }
    }
}

@Composable
private fun LoadingControls(modifier: Modifier = Modifier) {
    Row(
        modifier = modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CircularProgressIndicator(
            modifier = Modifier.size(32.dp),
        )
    }
}

@Composable
private fun PlayingControls(
    currentParagraph: Int,
    totalParagraphs: Int,
    onPause: () -> Unit,
    onSkipPrevious: () -> Unit,
    onSkipNext: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        // Paragraph counter
        Text(
            text = "$currentParagraph of $totalParagraphs",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )

        Spacer(modifier = Modifier.width(8.dp))

        // Control buttons
        Row(
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onSkipPrevious) {
                Icon(
                    imageVector = Icons.Default.SkipPrevious,
                    contentDescription = "Previous paragraph",
                    modifier = Modifier.size(32.dp),
                )
            }

            Spacer(modifier = Modifier.width(8.dp))

            IconButton(onClick = onPause) {
                Icon(
                    imageVector = Icons.Default.Pause,
                    contentDescription = "Pause narration",
                    modifier = Modifier.size(32.dp),
                )
            }

            Spacer(modifier = Modifier.width(8.dp))

            IconButton(onClick = onSkipNext) {
                Icon(
                    imageVector = Icons.Default.SkipNext,
                    contentDescription = "Next paragraph",
                    modifier = Modifier.size(32.dp),
                )
            }
        }
    }
}

@Composable
private fun PausedControls(
    currentParagraph: Int,
    totalParagraphs: Int,
    onResume: () -> Unit,
    onSkipPrevious: () -> Unit,
    onSkipNext: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        // Paragraph counter
        Text(
            text = "$currentParagraph of $totalParagraphs",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )

        Spacer(modifier = Modifier.width(8.dp))

        // Control buttons
        Row(
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onSkipPrevious) {
                Icon(
                    imageVector = Icons.Default.SkipPrevious,
                    contentDescription = "Previous paragraph",
                    modifier = Modifier.size(32.dp),
                )
            }

            Spacer(modifier = Modifier.width(8.dp))

            IconButton(onClick = onResume) {
                Icon(
                    imageVector = Icons.Default.PlayArrow,
                    contentDescription = "Resume narration",
                    modifier = Modifier.size(32.dp),
                )
            }

            Spacer(modifier = Modifier.width(8.dp))

            IconButton(onClick = onSkipNext) {
                Icon(
                    imageVector = Icons.Default.SkipNext,
                    contentDescription = "Next paragraph",
                    modifier = Modifier.size(32.dp),
                )
            }
        }
    }
}

@Composable
private fun ErrorControls(
    errorMessage: String,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Row(
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                imageVector = Icons.Default.ErrorOutline,
                contentDescription = "Error",
                tint = MaterialTheme.colorScheme.error,
                modifier = Modifier.size(24.dp),
            )

            Spacer(modifier = Modifier.width(8.dp))

            Text(
                text = errorMessage,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.error,
            )

            Spacer(modifier = Modifier.width(8.dp))

            IconButton(onClick = onRetry) {
                Icon(
                    imageVector = Icons.Default.Refresh,
                    contentDescription = "Retry narration",
                    modifier = Modifier.size(24.dp),
                )
            }
        }
    }
}
