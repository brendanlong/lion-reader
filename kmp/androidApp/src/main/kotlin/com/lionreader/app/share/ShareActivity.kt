package com.lionreader.app.share

import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.work.WorkInfo
import androidx.work.WorkManager
import com.lionreader.app.MainActivity
import com.lionreader.app.graph
import com.lionreader.app.ui.LionReaderTheme
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.map

/**
 * The share-sheet target: saves the shared link (see [SaveWorker]) and shows how that goes in a
 * small dialog over the app it was shared from.
 */
class ShareActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val link =
            intent
                .takeIf { it.action == Intent.ACTION_SEND }
                ?.getStringExtra(Intent.EXTRA_TEXT)
                .let(::sharedLink)
        val signedIn = graph.connection.value.auth.signedIn.value
        // Only once: a recreated dialog (rotation) follows the same work.
        if (savedInstanceState == null && link != null && signedIn) SaveWorker.enqueue(this, link)
        setContent {
            val settings by graph.currentSettings.collectAsStateWithLifecycle()
            LionReaderTheme(settings.theme) {
                when {
                    link == null -> Message("There's no link to save in what was shared.")
                    !signedIn ->
                        Message(
                            "Sign in to Lion Reader to save links.",
                            action = "Open Lion Reader" to ::openApp,
                        )
                    else -> Progress(link)
                }
            }
        }
    }

    @Composable
    private fun Progress(link: String) {
        val work by
            remember(link) {
                    WorkManager.getInstance(this)
                        .getWorkInfosForUniqueWorkFlow(SaveWorker.workName(link))
                        .map { it.lastOrNull() }
                }
                .collectAsStateWithLifecycle(null)
        val info = work
        when (info?.state) {
            WorkInfo.State.SUCCEEDED -> {
                val title = info.outputData.getString(SaveWorker.TITLE)
                LaunchedEffect(Unit) {
                    delay(1_200)
                    finish()
                }
                Message(if (title != null) "Saved “$title”." else "Saved.")
            }
            WorkInfo.State.FAILED ->
                Message(
                    info.outputData.getString(SaveWorker.ERROR)
                        ?: "Lion Reader couldn't save this link."
                )
            WorkInfo.State.ENQUEUED if info.runAttemptCount > 0 ->
                Message("Couldn't reach Lion Reader. It'll keep trying in the background.")
            WorkInfo.State.ENQUEUED if !isOnline() ->
                Message("You're offline. The link will be saved when you're back online.")
            WorkInfo.State.CANCELLED -> LaunchedEffect(Unit) { finish() }
            else -> Message("Saving…")
        }
    }

    @Composable
    private fun Message(text: String, action: Pair<String, () -> Unit>? = null) {
        AlertDialog(
            onDismissRequest = ::finish,
            title = { Text("Save to Lion Reader") },
            text = { Text(text) },
            confirmButton = {
                action?.let { (label, onClick) -> TextButton(onClick = onClick) { Text(label) } }
                    ?: TextButton(onClick = ::finish) { Text("Close") }
            },
            dismissButton = action?.let { { TextButton(onClick = ::finish) { Text("Close") } } },
        )
    }

    private fun openApp() {
        startActivity(Intent(this, MainActivity::class.java))
        finish()
    }

    private fun isOnline(): Boolean {
        val connectivity = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        return connectivity
            .getNetworkCapabilities(connectivity.activeNetwork)
            ?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true
    }
}
