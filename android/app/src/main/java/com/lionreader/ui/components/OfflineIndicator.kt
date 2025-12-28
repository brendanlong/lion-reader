package com.lionreader.ui.components

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material.icons.filled.Wifi
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.lionreader.ui.theme.Success
import kotlinx.coroutines.delay

/**
 * A banner that appears at the top of the screen when offline.
 *
 * Shows a persistent indicator that the user is offline. Automatically
 * hides when connectivity is restored.
 *
 * @param isOnline Whether the device is currently online
 * @param modifier Modifier for the component
 */
@Composable
fun OfflineBanner(
    isOnline: Boolean,
    modifier: Modifier = Modifier,
) {
    AnimatedVisibility(
        visible = !isOnline,
        enter = expandVertically(),
        exit = shrinkVertically(),
        modifier = modifier,
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .background(MaterialTheme.colorScheme.errorContainer),
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.Center,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    imageVector = Icons.Default.CloudOff,
                    contentDescription = null,
                    modifier = Modifier.size(16.dp),
                    tint = MaterialTheme.colorScheme.onErrorContainer,
                )

                Text(
                    text = "You're offline",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onErrorContainer,
                    modifier = Modifier.padding(start = 8.dp),
                )
            }
        }
    }
}

/**
 * An icon button style offline indicator for use in TopAppBar actions.
 *
 * Shows a cloud-off icon when offline.
 *
 * @param isOnline Whether the device is currently online
 * @param modifier Modifier for the icon
 */
@Composable
fun OfflineIcon(
    isOnline: Boolean,
    modifier: Modifier = Modifier,
) {
    if (!isOnline) {
        Icon(
            imageVector = Icons.Default.CloudOff,
            contentDescription = "Offline",
            modifier = modifier.padding(horizontal = 8.dp),
            tint = MaterialTheme.colorScheme.error,
        )
    }
}

/**
 * Manages connectivity-related snackbar messages.
 *
 * Shows a snackbar when connectivity is lost and another when it's restored.
 * The "connected" message auto-dismisses after a short delay.
 *
 * @param isOnline Whether the device is currently online
 * @param snackbarHostState The SnackbarHostState to show messages
 * @param onSyncRequested Optional callback when user requests sync after reconnection
 */
@Composable
fun ConnectivitySnackbarEffect(
    isOnline: Boolean,
    snackbarHostState: SnackbarHostState,
    onSyncRequested: (() -> Unit)? = null,
) {
    var previousOnlineState by remember { mutableStateOf(isOnline) }
    var wasOffline by remember { mutableStateOf(!isOnline) }

    LaunchedEffect(isOnline) {
        // Skip on initial composition
        if (previousOnlineState == isOnline) return@LaunchedEffect

        previousOnlineState = isOnline

        if (!isOnline) {
            // Going offline
            wasOffline = true
            snackbarHostState.currentSnackbarData?.dismiss()
            snackbarHostState.showSnackbar(
                message = "You're offline. Changes will sync when you reconnect.",
                duration = SnackbarDuration.Long,
            )
        } else if (wasOffline) {
            // Coming back online
            snackbarHostState.currentSnackbarData?.dismiss()
            val result = snackbarHostState.showSnackbar(
                message = "Back online",
                actionLabel = if (onSyncRequested != null) "Sync Now" else null,
                duration = SnackbarDuration.Short,
            )

            if (result == SnackbarResult.ActionPerformed) {
                onSyncRequested?.invoke()
            }

            // Reset wasOffline after showing the reconnection message
            delay(500)
            wasOffline = false
        }
    }
}

/**
 * A small connectivity status indicator for inline use.
 *
 * Shows either an offline icon or an online icon with color coding.
 *
 * @param isOnline Whether the device is currently online
 * @param showWhenOnline Whether to show an indicator when online (default: false)
 * @param modifier Modifier for the component
 */
@Composable
fun ConnectivityIndicator(
    isOnline: Boolean,
    modifier: Modifier = Modifier,
    showWhenOnline: Boolean = false,
) {
    if (!isOnline) {
        Row(
            modifier = modifier,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                imageVector = Icons.Default.CloudOff,
                contentDescription = "Offline",
                modifier = Modifier.size(14.dp),
                tint = MaterialTheme.colorScheme.error,
            )
            Text(
                text = "Offline",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.error,
            )
        }
    } else if (showWhenOnline) {
        Row(
            modifier = modifier,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                imageVector = Icons.Default.Wifi,
                contentDescription = "Online",
                modifier = Modifier.size(14.dp),
                tint = Success,
            )
            Text(
                text = "Online",
                style = MaterialTheme.typography.labelSmall,
                color = Success,
            )
        }
    }
}
