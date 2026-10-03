package com.lionreader.app

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.widget.Toast
import androidx.core.net.toUri
import androidx.lifecycle.Observer
import androidx.work.WorkInfo
import androidx.work.WorkManager
import com.lionreader.app.share.SaveWorker
import com.lionreader.shared.links.MAX_LINK_LENGTH

/** Opens a web page ([com.lionreader.shared.links.webUrl]) in the browser. */
fun Context.openWebPage(url: String) = startOrSay(Intent(Intent.ACTION_VIEW, url.toUri()))

fun Context.shareWebPage(url: String, title: String?) =
    startOrSay(
        Intent.createChooser(
            Intent(Intent.ACTION_SEND)
                .setType("text/plain")
                .putExtra(Intent.EXTRA_TEXT, url)
                .putExtra(Intent.EXTRA_SUBJECT, title),
            null,
        )
    )

/**
 * Saves a web page to Lion Reader, as sharing it to the app does: in the background, retrying, and
 * saying how it went (as the share dialog does) once it's done.
 */
fun Context.saveWebPage(url: String) {
    val app = applicationContext
    fun say(text: String) = Toast.makeText(app, text, Toast.LENGTH_SHORT).show()
    // Signed out, the job fails saying so.
    if (url.length > MAX_LINK_LENGTH) return say("That link is too long to save")
    val work = WorkManager.getInstance(app).getWorkInfoByIdLiveData(SaveWorker.enqueue(app, url))
    say("Saving…")
    work.observeForever(
        object : Observer<WorkInfo?> {
            override fun onChanged(value: WorkInfo?) {
                when (value?.state) {
                    WorkInfo.State.SUCCEEDED ->
                        say(
                            value.outputData.getString(SaveWorker.TITLE)?.let { "Saved “$it”" }
                                ?: "Saved"
                        )
                    WorkInfo.State.FAILED ->
                        say(
                            value.outputData.getString(SaveWorker.ERROR)
                                ?: "Lion Reader couldn't save this link"
                        )
                    WorkInfo.State.CANCELLED -> {}
                    else -> return
                }
                work.removeObserver(this)
            }
        }
    )
}

fun Context.copyLink(url: String) {
    getSystemService(ClipboardManager::class.java)
        .setPrimaryClip(ClipData.newPlainText("Link", url))
    // Android 13 shows its own confirmation.
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
        Toast.makeText(this, "Link copied", Toast.LENGTH_SHORT).show()
    }
}

/** No app to handle it (no browser, say) is the user's to know, not a crash. */
private fun Context.startOrSay(intent: Intent) {
    runCatching { startActivity(intent) }
        .onFailure { Toast.makeText(this, "No app can open this link", Toast.LENGTH_SHORT).show() }
}
