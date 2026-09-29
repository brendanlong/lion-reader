package com.lionreader.app.reader

import android.annotation.SuppressLint
import android.content.Intent
import android.view.ViewGroup
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import androidx.webkit.WebViewAssetLoader

/**
 * The article body. Hardened because it renders untrusted (server-sanitized) HTML next to the app's
 * credentials: no JavaScript, no file or content access, no JS bridge, and every navigation leaves
 * the WebView for the browser. Bundled fonts come through [WebViewAssetLoader] rather than file://
 * access.
 */
@Composable
fun ReaderWebView(document: String, modifier: Modifier = Modifier) {
    AndroidView(
        modifier = modifier,
        factory = { context ->
            WebView(context).apply {
                settings.javaScriptEnabled = false
                settings.allowFileAccess = false
                settings.allowContentAccess = false
                settings.domStorageEnabled = false
                setBackgroundColor(android.graphics.Color.TRANSPARENT)
                webViewClient =
                    ReaderWebViewClient(
                        WebViewAssetLoader.Builder()
                            .addPathHandler(
                                "/assets/",
                                WebViewAssetLoader.AssetsPathHandler(context),
                            )
                            .build()
                    )
            }
        },
        update = { view ->
            if (view.tag != document) {
                view.tag = document
                view.loadDataWithBaseURL("$ASSET_ORIGIN/", document, "text/html", "utf-8", null)
            }
        },
    )
}

// Lint's detector doesn't see the Kotlin override below (it does exist).
@SuppressLint("MissingOnRenderProcessGone")
private class ReaderWebViewClient(private val assets: WebViewAssetLoader) : WebViewClient() {
    override fun shouldInterceptRequest(
        view: WebView,
        request: WebResourceRequest,
    ): WebResourceResponse? = assets.shouldInterceptRequest(request.url)

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val url = request.url
        if (url.scheme == "http" || url.scheme == "https" || url.scheme == "mailto") {
            runCatching {
                view.context.startActivity(
                    Intent(Intent.ACTION_VIEW, url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            }
        }
        return true
    }

    // A renderer crash (or the system reclaiming it) would otherwise take the
    // whole app down; drop this WebView instead. Reopening the entry makes a
    // new one.
    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
        (view.parent as? ViewGroup)?.removeView(view)
        view.destroy()
        return true
    }
}
