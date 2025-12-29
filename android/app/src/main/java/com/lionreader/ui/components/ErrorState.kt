package com.lionreader.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

/**
 * Types of errors that can be displayed.
 */
enum class ErrorType {
    /** Network connectivity error */
    NETWORK,

    /** API or server error */
    API,

    /** Generic error */
    GENERIC,
}

/**
 * A reusable full-screen error state component.
 *
 * Displays an error icon, title, message, and an optional retry button.
 * Supports different error types with appropriate icons and styling.
 *
 * @param message The error message to display
 * @param modifier Modifier for the component
 * @param title Optional title for the error state
 * @param errorType The type of error to display (affects icon selection)
 * @param onRetry Optional callback for retry button. If null, no button is shown.
 * @param retryButtonText Text for the retry button
 */
@Composable
fun ErrorState(
    message: String,
    modifier: Modifier = Modifier,
    title: String = getDefaultTitle(ErrorType.GENERIC),
    errorType: ErrorType = ErrorType.GENERIC,
    onRetry: (() -> Unit)? = null,
    retryButtonText: String = "Retry",
) {
    val icon = getIconForErrorType(errorType)
    val iconTint =
        when (errorType) {
            ErrorType.NETWORK -> MaterialTheme.colorScheme.onSurfaceVariant
            ErrorType.API -> MaterialTheme.colorScheme.error
            ErrorType.GENERIC -> MaterialTheme.colorScheme.error
        }

    Box(
        modifier = modifier.fillMaxSize(),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            modifier =
                Modifier
                    .fillMaxWidth()
                    .padding(32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            // Error icon
            Icon(
                imageVector = icon,
                contentDescription = null,
                modifier = Modifier.size(64.dp),
                tint = iconTint,
            )

            Spacer(modifier = Modifier.height(24.dp))

            // Title
            Text(
                text = title,
                style = MaterialTheme.typography.headlineSmall,
                color = MaterialTheme.colorScheme.onSurface,
                textAlign = TextAlign.Center,
            )

            Spacer(modifier = Modifier.height(8.dp))

            // Message
            Text(
                text = message,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )

            // Retry button
            if (onRetry != null) {
                Spacer(modifier = Modifier.height(24.dp))

                Button(
                    onClick = onRetry,
                    colors =
                        ButtonDefaults.buttonColors(
                            containerColor = MaterialTheme.colorScheme.primary,
                        ),
                ) {
                    Text(text = retryButtonText)
                }
            }
        }
    }
}

/**
 * A compact inline error state for use within content areas.
 *
 * Displays a smaller error indicator with message and optional retry.
 *
 * @param message The error message to display
 * @param modifier Modifier for the component
 * @param onRetry Optional callback for retry action
 */
@Composable
fun InlineErrorState(
    message: String,
    modifier: Modifier = Modifier,
    onRetry: (() -> Unit)? = null,
) {
    Column(
        modifier =
            modifier
                .fillMaxWidth()
                .padding(16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(
            imageVector = Icons.Default.ErrorOutline,
            contentDescription = null,
            modifier = Modifier.size(32.dp),
            tint = MaterialTheme.colorScheme.error,
        )

        Spacer(modifier = Modifier.height(8.dp))

        Text(
            text = message,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )

        if (onRetry != null) {
            Spacer(modifier = Modifier.height(8.dp))

            OutlinedButton(
                onClick = onRetry,
            ) {
                Text(
                    text = "Retry",
                    style = MaterialTheme.typography.labelMedium,
                )
            }
        }
    }
}

/**
 * A network-specific error state with appropriate messaging.
 *
 * Convenience wrapper for common network error scenarios.
 *
 * @param modifier Modifier for the component
 * @param onRetry Optional callback for retry action
 */
@Composable
fun NetworkErrorState(
    modifier: Modifier = Modifier,
    onRetry: (() -> Unit)? = null,
) {
    ErrorState(
        title = "No Connection",
        message = "Unable to connect to the server. Please check your internet connection and try again.",
        errorType = ErrorType.NETWORK,
        onRetry = onRetry,
        modifier = modifier,
    )
}

/**
 * An API error state for server-side errors.
 *
 * @param message The error message from the API
 * @param modifier Modifier for the component
 * @param onRetry Optional callback for retry action
 */
@Composable
fun ApiErrorState(
    message: String,
    modifier: Modifier = Modifier,
    onRetry: (() -> Unit)? = null,
) {
    ErrorState(
        title = "Something Went Wrong",
        message = message,
        errorType = ErrorType.API,
        onRetry = onRetry,
        modifier = modifier,
    )
}

/**
 * Gets the default title for an error type.
 */
private fun getDefaultTitle(errorType: ErrorType): String =
    when (errorType) {
        ErrorType.NETWORK -> "No Connection"
        ErrorType.API -> "Something Went Wrong"
        ErrorType.GENERIC -> "Error"
    }

/**
 * Gets the appropriate icon for an error type.
 */
private fun getIconForErrorType(errorType: ErrorType): ImageVector =
    when (errorType) {
        ErrorType.NETWORK -> Icons.Default.CloudOff
        ErrorType.API -> Icons.Default.Error
        ErrorType.GENERIC -> Icons.Default.ErrorOutline
    }
