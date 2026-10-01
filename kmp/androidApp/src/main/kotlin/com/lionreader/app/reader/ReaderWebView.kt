package com.lionreader.app.reader

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.RectF
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalViewConfiguration
import androidx.compose.ui.viewinterop.AndroidView
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import kotlin.math.abs
import org.json.JSONArray
import org.json.JSONObject

/**
 * * The article: untrusted (server-sanitized) HTML next to the app's credentials, so hardened as
 *   SECURITY.md §1 requires. Bundled fonts and the script come through [WebViewAssetLoader] rather
 *   than file:// access.
 */
@Composable
fun ReaderWebView(
    document: String,
    modifier: Modifier = Modifier,
    narration: ReaderNarration = ReaderNarration(),
) {
    val current by rememberUpdatedState(narration)
    AndroidView(
        modifier = modifier,
        factory = { context ->
            ReaderView(context).apply {
                // For our scripts; the CSP keeps anything else from running.
                @SuppressLint("SetJavaScriptEnabled")
                settings.javaScriptEnabled = true
                settings.allowFileAccess = false
                settings.allowContentAccess = false
                settings.domStorageEnabled = false
                setBackgroundColor(android.graphics.Color.TRANSPARENT)
                // Drawn into its own layer, so the pager moving it shifts a
                // finished picture: on some devices a WebView that's moved
                // mid-swipe draws a blank frame.
                setLayerType(View.LAYER_TYPE_HARDWARE, null)
                if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                    WebViewCompat.addWebMessageListener(this, "lionReader", setOf(ASSET_ORIGIN)) {
                        _,
                        message,
                        _,
                        isMainFrame,
                        _ ->
                        if (isMainFrame) onPageMessage(message.data ?: "", current)
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
                view.pageReady = false
                view.loadDataWithBaseURL("$ASSET_ORIGIN/", document, "text/html", "utf-8", null)
            }
            view.highlight(narration.paragraph, narration.autoScroll)
        },
    )
}

/**
 * The article's narration in the page (the reader's narration.js): [paragraph] is the one to
 * highlight, if any. [onParagraphs] gets the text to speak once the page has extracted it, and
 * [onSeek] the paragraph the user tapped.
 */
data class ReaderNarration(
    val paragraph: Int? = null,
    val autoScroll: Boolean = true,
    val onParagraphs: (List<String>) -> Unit = {},
    val onSeek: (Int) -> Unit = {},
)

/**
 * Decides, once per gesture and as soon as its direction is clear, whether the article pager may
 * have it, like the web's swipe: only a drag at least [SWIPE_RATIO] times as far sideways as up or
 * down turns the page. Anything steeper stays the WebView's for the whole gesture, so a scroll that
 * drifts sideways never turns into a page turn halfway through. A sideways drag that starts on a
 * wide table or code block (reported by scroll-detect.js) also stays the WebView's while the block
 * can still scroll that way. It has to be decided here, synchronously, before the pager's touch
 * slop is crossed; Compose honors [requestDisallowInterceptTouchEvent] for the rest of the gesture.
 */
@SuppressLint("ViewConstructor")
private class ReaderView(context: Context) : WebView(context) {
    var sideScrollers: List<SideScroller> = emptyList()

    /** Whether the page's narration script has run (it reports the paragraphs when it does). */
    var pageReady = false
    private var wanted: Int? = null
    private var shown: Int? = null
    private var scroll = true

    fun onPageMessage(data: String, narration: ReaderNarration) {
        if (data.startsWith("[")) {
            sideScrollers = parseRects(data)
            return
        }
        val message = runCatching { JSONObject(data) }.getOrNull() ?: return
        when (message.optString("type")) {
            "narration" -> {
                val paragraphs = message.optJSONArray("paragraphs") ?: return
                narration.onParagraphs(List(paragraphs.length()) { paragraphs.getString(it) })
                pageReady = true
                shown = null
                highlight(wanted, scroll)
            }
            "seek" -> narration.onSeek(message.optInt("paragraph"))
        }
    }

    fun highlight(paragraph: Int?, autoScroll: Boolean) {
        wanted = paragraph
        scroll = autoScroll
        if (!pageReady || shown == paragraph) return
        shown = paragraph
        evaluateJavascript(
            "window.lionNarration && lionNarration.highlight(${paragraph ?: "null"}, $autoScroll)",
            null,
        )
    }

    /** The system touch slop: the pager waits for twice this ([pagerViewConfiguration]). */
    private val decideAfter = ViewConfiguration.get(context).scaledTouchSlop.toFloat()
    private var pointerId = MotionEvent.INVALID_POINTER_ID
    private var downX = 0f
    private var downY = 0f
    private var touched: SideScroller? = null
    private var deciding = false

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                pointerId = event.getPointerId(0)
                downX = event.x
                downY = event.y
                val density = resources.displayMetrics.density
                val pageX = (event.x + scrollX) / density
                val pageY = (event.y + scrollY) / density
                touched = sideScrollers.find { it.bounds.contains(pageX, pageY) }
                deciding = true
            }
            // Two fingers aren't a page turn.
            MotionEvent.ACTION_POINTER_DOWN -> if (deciding) keep()
            MotionEvent.ACTION_MOVE ->
                if (deciding) {
                    val index = event.findPointerIndex(pointerId)
                    if (index >= 0)
                        decide(event.getX(index) - downX, abs(event.getY(index) - downY))
                }
            MotionEvent.ACTION_UP,
            MotionEvent.ACTION_CANCEL -> deciding = false
        }
        return super.onTouchEvent(event)
    }

    /**
     * Rechecked on every move until it keeps the gesture or the pager takes it (a cancel), so a
     * drag that starts a little sideways and turns into a scroll is still kept.
     */
    private fun decide(dx: Float, dy: Float) {
        if (abs(dx) <= decideAfter && dy <= decideAfter) return
        val block = touched
        val wanted =
            when {
                abs(dx) < dy * SWIPE_RATIO -> true
                // A finger moving left scrolls the block's content right.
                block != null -> if (dx < 0) block.canScrollRight else block.canScrollLeft
                else -> false
            }
        if (wanted) keep()
    }

    private fun keep() {
        deciding = false
        parent?.requestDisallowInterceptTouchEvent(true)
    }

    private companion object {
        /** The web's 2:1 (`MAX_VERTICAL_RATIO` in EntryContentHelpers.ts). */
        const val SWIPE_RATIO = 2f
    }
}

/** [bounds] in CSS pixels, page coordinates. */
private class SideScroller(
    val bounds: RectF,
    val canScrollLeft: Boolean,
    val canScrollRight: Boolean,
)

private fun parseRects(json: String?): List<SideScroller> = runCatching {
    val rects = JSONArray(json)
    List(rects.length()) { i ->
        val r = rects.getJSONArray(i)
        SideScroller(
            RectF(
                r.getDouble(0).toFloat(),
                r.getDouble(1).toFloat(),
                r.getDouble(2).toFloat(),
                r.getDouble(3).toFloat(),
            ),
            canScrollLeft = r.getInt(4) == 1,
            canScrollRight = r.getInt(5) == 1,
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

/**
 * For the article pager: twice the touch slop (as Android's own paging slop), so a page's
 * [ReaderView] has decided whether to keep a drag before the pager could take it.
 */
@Composable
fun pagerViewConfiguration(): androidx.compose.ui.platform.ViewConfiguration {
    val config = LocalViewConfiguration.current
    return remember(config) {
        object : androidx.compose.ui.platform.ViewConfiguration by config {
            override val touchSlop = config.touchSlop * 2
        }
    }
}
