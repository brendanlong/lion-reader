package com.lionreader

import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Error
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.lifecycleScope
import com.lionreader.data.api.ApiResult
import com.lionreader.data.api.LionReaderApi
import com.lionreader.data.api.SessionStore
import com.lionreader.ui.theme.LionReaderTheme
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * Activity that receives share intents from other apps.
 *
 * When a user shares a URL to Lion Reader, this activity:
 * 1. Extracts the URL from the shared text
 * 2. Shows a brief saving indicator
 * 3. Calls the API to save the article
 * 4. Shows success/error feedback
 * 5. Closes automatically
 */
@AndroidEntryPoint
class ShareReceiverActivity : ComponentActivity() {
    @Inject
    lateinit var api: LionReaderApi

    @Inject
    lateinit var sessionStore: SessionStore

    private var saveState by mutableStateOf<SaveState>(SaveState.Saving)
    private var sharedUrl by mutableStateOf<String?>(null)
    private var sharedTitle by mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Check if user is logged in
        if (sessionStore.getToken() == null) {
            Toast.makeText(this, "Please log in to Lion Reader first", Toast.LENGTH_LONG).show()
            finish()
            return
        }

        // Extract shared content
        val result = extractSharedContent(intent)
        if (result == null) {
            Toast.makeText(this, "Could not extract URL from shared content", Toast.LENGTH_SHORT).show()
            finish()
            return
        }

        sharedUrl = result.url
        sharedTitle = result.title

        setContent {
            LionReaderTheme {
                ShareReceiverContent(
                    state = saveState,
                    url = sharedUrl,
                )
            }
        }

        // Start saving the article
        saveArticle(result.url, result.title)
    }

    private fun saveArticle(
        url: String,
        title: String?,
    ) {
        lifecycleScope.launch {
            when (val result = api.saveArticle(url = url, title = title)) {
                is ApiResult.Success -> {
                    saveState = SaveState.Success
                    delay(1500) // Show success briefly
                    finish()
                }
                is ApiResult.Error -> {
                    saveState = SaveState.Error(result.message)
                    delay(2500) // Show error a bit longer
                    finish()
                }
                is ApiResult.NetworkError -> {
                    saveState = SaveState.Error("Network error. Please check your connection.")
                    delay(2500)
                    finish()
                }
                is ApiResult.Unauthorized -> {
                    saveState = SaveState.Error("Please log in again.")
                    delay(2500)
                    finish()
                }
                is ApiResult.RateLimited -> {
                    saveState = SaveState.Error("Too many requests. Please try again later.")
                    delay(2500)
                    finish()
                }
            }
        }
    }

    private fun extractSharedContent(intent: Intent): SharedContent? {
        if (intent.action != Intent.ACTION_SEND) return null
        if (intent.type != "text/plain") return null

        val sharedText = intent.getStringExtra(Intent.EXTRA_TEXT) ?: return null
        val sharedSubject = intent.getStringExtra(Intent.EXTRA_SUBJECT)

        // Try to extract URL from the shared text
        val url = extractUrl(sharedText) ?: return null

        return SharedContent(url = url, title = sharedSubject)
    }

    private fun extractUrl(text: String): String? {
        // URL regex pattern
        val urlPattern =
            Regex(
                """https?://[^\s<>"{}|\\^`\[\]]+""",
                RegexOption.IGNORE_CASE,
            )

        // Find the first URL in the text
        val match = urlPattern.find(text)
        if (match != null) {
            return match.value
        }

        // If the entire text looks like a URL (without protocol), add https://
        val trimmed = text.trim()
        if (trimmed.contains(".") && !trimmed.contains(" ")) {
            return "https://$trimmed"
        }

        return null
    }

    private data class SharedContent(
        val url: String,
        val title: String?,
    )
}

sealed class SaveState {
    data object Saving : SaveState()

    data object Success : SaveState()

    data class Error(
        val message: String,
    ) : SaveState()
}

@Composable
private fun ShareReceiverContent(
    state: SaveState,
    url: String?,
) {
    Card(
        modifier =
            Modifier
                .fillMaxWidth()
                .padding(24.dp),
    ) {
        Column(
            modifier =
                Modifier
                    .fillMaxWidth()
                    .padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            when (state) {
                is SaveState.Saving -> {
                    CircularProgressIndicator(
                        modifier = Modifier.size(48.dp),
                    )
                    Spacer(modifier = Modifier.height(16.dp))
                    Text(
                        text = "Saving article...",
                        style = MaterialTheme.typography.titleMedium,
                    )
                    if (url != null) {
                        Spacer(modifier = Modifier.height(8.dp))
                        Text(
                            text = url,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                            textAlign = TextAlign.Center,
                        )
                    }
                }
                is SaveState.Success -> {
                    Icon(
                        imageVector = Icons.Default.CheckCircle,
                        contentDescription = null,
                        modifier = Modifier.size(48.dp),
                        tint = MaterialTheme.colorScheme.primary,
                    )
                    Spacer(modifier = Modifier.height(16.dp))
                    Text(
                        text = "Article saved!",
                        style = MaterialTheme.typography.titleMedium,
                    )
                }
                is SaveState.Error -> {
                    Icon(
                        imageVector = Icons.Default.Error,
                        contentDescription = null,
                        modifier = Modifier.size(48.dp),
                        tint = MaterialTheme.colorScheme.error,
                    )
                    Spacer(modifier = Modifier.height(16.dp))
                    Text(
                        text = "Failed to save",
                        style = MaterialTheme.typography.titleMedium,
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(
                        text = state.message,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = TextAlign.Center,
                    )
                }
            }
        }
    }
}
