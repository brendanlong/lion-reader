package com.lionreader.app

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.widget.Toast
import androidx.core.net.toUri
import com.lionreader.app.share.MAX_LINK_LENGTH
import com.lionreader.app.share.SaveWorker

/** [url] if it's a web address, the only kind the app opens, shares or links: feeds supply them. */
fun webUrl(url: String?): String? =
    url?.trim()?.takeIf { it.startsWith("https://", true) || it.startsWith("http://", true) }

/** Opens a web page ([webUrl]) in the browser. */
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

/** Saves a web page to Lion Reader, as sharing it to the app does: in the background, retrying. */
fun Context.saveWebPage(url: String) {
    if (url.length > MAX_LINK_LENGTH) {
        Toast.makeText(this, "That link is too long to save", Toast.LENGTH_SHORT).show()
        return
    }
    SaveWorker.enqueue(this, url)
    Toast.makeText(this, "Saving to Lion Reader", Toast.LENGTH_SHORT).show()
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
