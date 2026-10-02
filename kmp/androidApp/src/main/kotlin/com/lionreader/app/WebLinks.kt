package com.lionreader.app

import android.content.Context
import android.content.Intent
import android.widget.Toast
import androidx.core.net.toUri

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

/** No app to handle it (no browser, say) is the user's to know, not a crash. */
private fun Context.startOrSay(intent: Intent) {
    runCatching { startActivity(intent) }
        .onFailure { Toast.makeText(this, "No app can open this link", Toast.LENGTH_SHORT).show() }
}
