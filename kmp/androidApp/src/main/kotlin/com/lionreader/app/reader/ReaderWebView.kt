package com.lionreader.app.reader

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.RectF
import android.view.MotionEvent
import android.view.ViewConfiguration
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
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import kotlin.math.abs
import org.json.JSONArray

/**
 * The article body. Hardened because it renders untrusted (server-sanitized) HTML next to the app's
 * credentials: only our bundled script runs (readerDocument's CSP), no file or content access, no
 * JS bridge beyond one message channel open only to the asset origin, and every navigation leaves
 * the WebView for the browser. Bundled fonts and the script come through [WebViewAssetLoader]
 * rather than file:// access.
 */
@Composable
fun ReaderWebView(document: String, modifier: Modifier = Modifier) {
    AndroidView(
        modifier = modifier,
        factory = { context ->
            ReaderView(context).apply {
                // For scroll-detect.js; the CSP keeps anything else from running.
                @SuppressLint("SetJavaScriptEnabled")
                settings.javaScriptEnabled = true
                settings.allowFileAccess = false
                settings.allowContentAccess = false
                settings.domStorageEnabled = false
                setBackgroundColor(android.graphics.Color.TRANSPARENT)
                if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                    WebViewCompat.addWebMessageListener(this, "lionReader", setOf(ASSET_ORIGIN)) {
                        _,
                        message,
                        _,
                        isMainFrame,
                        _ ->
                        if (isMainFrame) sideScrollers = parseRects(message.data)
                    }
                }
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
                view.sideScrollers = emptyList()
                view.loadDataWithBaseURL("$ASSET_ORIGIN/", document, "text/html", "utf-8", null)
            }
        },
    )
}

/**
 * Keeps a sideways drag that starts on a wide table or code block (reported by scroll-detect.js)
 * for the WebView, so the block scrolls instead of the article pager turning the page. It has to be
 * decided here, synchronously, before the pager's touch slop is crossed; Compose honors
 * [requestDisallowInterceptTouchEvent] for the rest of the gesture.
 */
@SuppressLint("ViewConstructor")
private class ReaderView(context: Context) : WebView(context) {
    /** In CSS pixels, page coordinates. */
    var sideScrollers: List<RectF> = emptyList()

    private val decideAfter = ViewConfiguration.get(context).scaledTouchSlop / 2f
    private var downX = 0f
    private var downY = 0f
    private var undecided = false

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                downX = event.x
                downY = event.y
                val density = resources.displayMetrics.density
                undecided = sideScrollers.any { it.contains(event.x / density, event.y / density) }
            }
            MotionEvent.ACTION_MOVE ->
                if (undecided) {
                    val dx = abs(event.x - downX)
                    val dy = abs(event.y - downY)
                    if (dx > decideAfter && dx > dy) {
                        parent?.requestDisallowInterceptTouchEvent(true)
                        undecided = false
                    } else if (dy > decideAfter) {
                        undecided = false
                    }
                }
        }
        return super.onTouchEvent(event)
    }
}

private fun parseRects(json: String?): List<RectF> = runCatching {
    val rects = JSONArray(json)
    List(rects.length()) { i ->
        val r = rects.getJSONArray(i)
        RectF(
            r.getDouble(0).toFloat(),
            r.getDouble(1).toFloat(),
            r.getDouble(2).toFloat(),
            r.getDouble(3).toFloat(),
        )
    }
}
    .getOrDefault(emptyList())

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
