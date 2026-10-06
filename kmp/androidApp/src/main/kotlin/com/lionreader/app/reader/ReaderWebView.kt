package com.lionreader.app.reader

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.Rect
import android.graphics.RectF
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.ActionMode
import android.view.Menu
import android.view.MenuItem
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.ScrollIndicatorState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalViewConfiguration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.lionreader.app.copyLink
import com.lionreader.app.openWebPage
import com.lionreader.app.saveWebPage
import com.lionreader.app.shareWebPage
import com.lionreader.app.ui.PAGE_FRACTION
import com.lionreader.app.ui.PageLayer
import com.lionreader.app.ui.PageTurns
import com.lionreader.app.ui.scrollbar
import com.lionreader.shared.reader.AppearanceTokens
import com.lionreader.shared.reader.linkTarget
import kotlin.math.abs
import kotlin.math.roundToInt
import org.json.JSONArray
import org.json.JSONObject

/**
 * The article: untrusted (server-sanitized) HTML next to the app's credentials, so hardened as
 * SECURITY.md §1 requires. Bundled fonts and the script come through [WebViewAssetLoader] rather
 * than file:// access. The only WebView in the app (entry HTML can hold MathML, SVG, tables and
 * embeds), with the article's header in it too. It fills the page and scrolls itself: sized to its
 * content inside a scrolling layout, a WebView stays blank until it has measured.
 */
@Composable
fun ReaderWebView(
    document: String,
    position: ReadingPosition,
    modifier: Modifier = Modifier,
    narration: ReaderNarration = ReaderNarration(),
    paging: ReaderPaging = ReaderPaging(),
) {
    val current by rememberUpdatedState(narration)
    val shown = remember { arrayOfNulls<ReaderView>(1) }
    val losses = remember { RendererLosses() }
    val turns = paging.turns
    if (turns != null) {
        DisposableEffect(turns) {
            val unregister = turns.register(PageLayer.ARTICLE) { shown[0]?.turnPage(it) ?: false }
            onDispose { unregister() }
        }
    }
    if (losses.gaveUp) {
        Box(modifier.padding(16.dp)) { Text("This article couldn't be shown.") }
        return
    }
    var linkPress by remember(document) { mutableStateOf<LinkPress?>(null) }
    var scrolled by remember { mutableStateOf<ScrollIndicatorState?>(null) }
    Box(modifier.scrollbar { scrolled }) {
        key(losses.generation) {
            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = { context ->
                    ReaderView(context)
                        .also {
                            shown[0] = it
                            scrolled = it.scrollIndicator
                        }
                        .apply {
                            onLinkLongPress = { linkPress = it }
                            // For our scripts; the CSP keeps anything else from running.
                            @SuppressLint("SetJavaScriptEnabled")
                            settings.javaScriptEnabled = true
                            settings.allowFileAccess = false
                            settings.allowContentAccess = false
                            settings.domStorageEnabled = false
                            setBackgroundColor(android.graphics.Color.TRANSPARENT)
                            isVerticalScrollBarEnabled = false
                            // Drawn into its own layer, so the pager moving it shifts a
                            // finished picture: on some devices a WebView that's moved
                            // mid-swipe draws a blank frame.
                            setLayerType(View.LAYER_TYPE_HARDWARE, null)
                            if (
                                WebViewFeature.isFeatureSupported(
                                    WebViewFeature.WEB_MESSAGE_LISTENER
                                )
                            ) {
                                WebViewCompat.addWebMessageListener(
                                    this,
                                    "lionReader",
                                    setOf(ASSET_ORIGIN),
                                ) { _, message, _, isMainFrame, _ ->
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
                                        .build(),
                                    onRendererLost = losses::lost,
                                )
                        }
                },
                update = { view ->
                    // It mustn't be used any more; a new one is on its way.
                    if (view.rendererLost) return@AndroidView
                    view.position = position
                    if (view.tag != document) {
                        view.tag = document
                        view.sideScrollers = emptyList()
                        view.pageReady = false
                        view.restoring = true
                        view.loadDataWithBaseURL(
                            "$ASSET_ORIGIN/",
                            document,
                            "text/html",
                            "utf-8",
                            null,
                        )
                    }
                    view.smoothScroll = paging.smoothScroll
                    view.pageScrolling = paging.swipes
                    view.highlight(narration.paragraph, narration.autoScroll)
                    view.onListenFrom = narration.onListenFrom
                },
                onRelease = { it.destroy() },
            )
        }
        linkPress?.let { LinkMenu(it) { linkPress = null } }
    }
}

/**
 * How far down the article the reader is ([fraction] of its height), kept outside the WebView,
 * which can be replaced (the system reclaims renderers of apps in the background) or reload (text
 * size, the summary), so the page comes back there rather than to the top.
 */
class ReadingPosition(var fraction: Float = 0f) {
    companion object {
        val Saver: Saver<ReadingPosition, Float> =
            Saver(save = { it.fraction }, restore = { ReadingPosition(it) })
    }
}

/** A long press on a link in the page: its address, and where (the view's pixels). */
internal data class LinkPress(val url: String, val x: Float, val y: Float)

/**
 * What a long press on a link offers, where it was pressed: the most common first (Open, as a tap
 * does), then saving it to Lion Reader, then the system's Share and Copy, as browsers' link menus
 * end.
 */
@Composable
internal fun LinkMenu(press: LinkPress, onDismiss: () -> Unit) {
    val context = LocalContext.current
    fun act(action: () -> Unit) {
        onDismiss()
        action()
    }
    Box(Modifier.offset { IntOffset(press.x.roundToInt(), press.y.roundToInt()) }) {
        DropdownMenu(expanded = true, onDismissRequest = onDismiss) {
            // Where it goes, before choosing what to do with it.
            Text(
                press.url,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier =
                    Modifier.widthIn(max = 280.dp).padding(horizontal = 12.dp, vertical = 8.dp),
            )
            DropdownMenuItem(
                text = { Text("Open") },
                onClick = { act { context.openWebPage(press.url) } },
            )
            DropdownMenuItem(
                text = { Text("Save") },
                onClick = { act { context.saveWebPage(press.url) } },
            )
            DropdownMenuItem(
                text = { Text("Share") },
                onClick = { act { context.shareWebPage(press.url, null) } },
            )
            DropdownMenuItem(
                text = { Text("Copy link") },
                onClick = { act { context.copyLink(press.url) } },
            )
        }
    }
}

/**
 * A page whose renderer went away gets a new WebView. The system reclaiming renderers is routine
 * (low-memory e-readers do it often); a page whose renderer crashes [MAX_RENDERER_CRASHES] times
 * within [CRASH_WINDOW_MILLIS] is given up on, whether or not it loaded in between, so one that
 * crashes just after loading doesn't reload for ever.
 */
internal class RendererLosses(private val now: () -> Long = SystemClock::elapsedRealtime) {
    /** Keys the page's WebView: a new one each loss. */
    var generation by mutableIntStateOf(0)
        private set

    private val crashes = ArrayDeque<Long>()
    var gaveUp by mutableStateOf(false)
        private set

    fun lost(crashed: Boolean) {
        if (crashed) {
            val at = now()
            crashes.addLast(at)
            while (at - crashes.first() > CRASH_WINDOW_MILLIS) crashes.removeFirst()
            if (crashes.size >= MAX_RENDERER_CRASHES) gaveUp = true
        }
        generation++
    }
}

internal const val CRASH_WINDOW_MILLIS = 60_000L
internal const val MAX_RENDERER_CRASHES = 3

/**
 * The article's narration in the page. The reader's narration.js is the web's own code (bundled
 * from `src/lib/narration/app-reader.ts`), so the app numbers, speaks and highlights an article
 * exactly as the web does, offline included. [paragraph] is the one to highlight, if any.
 * [onParagraphs] gets the text to speak once the page has extracted it, [onSeek] the paragraph the
 * user tapped, and [onListenFrom] the paragraph a selection starts in, when its menu's Listen is
 * tapped (offered only when this is given).
 */
data class ReaderNarration(
    val paragraph: Int? = null,
    val autoScroll: Boolean = true,
    val onParagraphs: (List<String>) -> Unit = {},
    val onSeek: (Int) -> Unit = {},
    val onListenFrom: ((Int) -> Unit)? = null,
)

/**
 * How the page scrolls. With [swipes] (page mode, for e-readers) a swipe up or down moves it
 * [PAGE_FRACTION] of the screen at once rather than scrolling with the finger; [turns], when given
 * (the article on screen), has the volume buttons do the same. [smoothScroll]: narration scrolls to
 * its paragraph smoothly rather than jumping (off with animations).
 */
data class ReaderPaging(
    val swipes: Boolean = false,
    val turns: PageTurns? = null,
    val smoothScroll: Boolean = true,
)

/**
 * Decides, once per gesture and as soon as its direction is clear, whether the article pager may
 * have it, like the web's swipe: only a drag at least [SWIPE_RATIO] times as far sideways as up or
 * down turns the page. Anything steeper stays the WebView's for the whole gesture, so a scroll that
 * drifts sideways never turns into a page turn halfway through. A sideways drag that starts on a
 * wide table or code block (reported by scroll-detect.js) also stays the WebView's while the block
 * can still scroll that way. It has to be decided here, synchronously, before the pager's touch
 * slop is crossed; Compose honors [requestDisallowInterceptTouchEvent] for the rest of the gesture.
 * In page mode a scroll it keeps becomes a page turn instead ([turnPage]), unless it began as a
 * long press: dragging after one extends a text selection.
 */
@SuppressLint("ViewConstructor")
private class ReaderView(context: Context) : WebView(context) {
    var sideScrollers: List<SideScroller> = emptyList()

    /** Whether the page's narration script has run (it reports the paragraphs when it does). */
    var pageReady = false
    /** Its renderer is gone, so it can only be destroyed. */
    var rendererLost = false
    var position = ReadingPosition()

    /** Until the page has loaded and gone back to [position], its scrolling isn't the reader's. */
    var restoring = true
    private var wanted: Int? = null
    private var shown: Int? = null
    private var scroll = true
    var smoothScroll = true
    var pageScrolling = false

    /** A long press on a web link; anything else keeps the WebView's own (selecting text). */
    var onLinkLongPress: ((LinkPress) -> Unit)? = null

    private var scrolledTo by mutableIntStateOf(0)

    /** For the page's scrollbar: drawn in Compose, as the lists' are, rather than the WebView's. */
    val scrollIndicator =
        object : ScrollIndicatorState {
            override val scrollOffset: Int
                get() = scrolledTo

            override val contentSize: Int
                get() = computeVerticalScrollRange()

            override val viewportSize: Int
                get() = height
        }

    override fun onScrollChanged(l: Int, t: Int, oldl: Int, oldt: Int) {
        super.onScrollChanged(l, t, oldl, oldt)
        scrolledTo = t
        val range = computeVerticalScrollRange()
        if (!restoring && range > 0) position.fraction = t.toFloat() / range
    }

    /**
     * Once everything in the page (images included) is laid out, so for an unchanged article the
     * place is exactly where it was. Not if the reader has already scrolled it.
     */
    fun onLoaded() {
        if (!restoring || rendererLost) return
        restoring = false
        val fraction = position.fraction
        if (fraction > 0f && scrollY == 0) {
            evaluateJavascript(
                "window.scrollTo(0, $fraction * document.documentElement.scrollHeight)",
                null,
            )
        }
    }

    init {
        setOnLongClickListener { longPressLink() }
    }

    private fun longPressLink(): Boolean {
        val report = onLinkLongPress ?: return false
        val x = downX
        val y = downY
        val pressed = { href: String? ->
            linkTarget(href, ASSET_ORIGIN)?.let { report(LinkPress(it, x, y)) }
        }
        val hit = hitTestResult
        val handled =
            when (hit.type) {
                HitTestResult.SRC_ANCHOR_TYPE ->
                    linkTarget(hit.extra, ASSET_ORIGIN)?.also { pressed(it) } != null
                // A linked image: the hit is the image; the page says where the link goes. That
                // answer comes after the press is taken, so a linked image whose link isn't a web
                // page gets no menu, and not the WebView's own long press either.
                HitTestResult.SRC_IMAGE_ANCHOR_TYPE -> {
                    val reply =
                        Handler(Looper.getMainLooper()) { message ->
                            pressed(message.data.getString("url"))
                            true
                        }
                    requestFocusNodeHref(reply.obtainMessage())
                    true
                }
                else -> false
            }
        // The rest of the gesture is the menu's: a drag after it mustn't turn the article.
        if (handled) keep()
        return handled
    }

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
                // The reader's place wins over paused narration's; playing, the next paragraph
                // scrolls to it.
                highlight(wanted, scroll && position.fraction == 0f)
            }
            "seek" -> narration.onSeek(message.optInt("paragraph"))
        }
    }

    var onListenFrom: ((Int) -> Unit)? = null

    /** The text selection's menu, with "Listen" (from here) once the page can narrate. */
    override fun startActionMode(callback: ActionMode.Callback?, type: Int): ActionMode? =
        super.startActionMode(callback?.let(::ListenFromHere), type)

    private inner class ListenFromHere(private val wrapped: ActionMode.Callback) :
        ActionMode.Callback2() {
        override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean {
            val created = wrapped.onCreateActionMode(mode, menu)
            if (created) addListen(menu)
            return created
        }

        // The WebView rebuilds its items as the selection changes; Listen stays.
        override fun onPrepareActionMode(mode: ActionMode, menu: Menu): Boolean {
            wrapped.onPrepareActionMode(mode, menu)
            addListen(menu)
            return true
        }

        private fun addListen(menu: Menu) {
            if (pageReady && onListenFrom != null && menu.findItem(LISTEN_FROM_HERE) == null) {
                // On the toolbar itself: "if room" puts it behind the overflow,
                // after Define, Copy, Select all and Share.
                @SuppressLint("AlwaysShowAction")
                menu
                    .add(Menu.NONE, LISTEN_FROM_HERE, 0, "Listen")
                    .setShowAsAction(MenuItem.SHOW_AS_ACTION_ALWAYS)
            }
        }

        override fun onActionItemClicked(mode: ActionMode, item: MenuItem): Boolean {
            if (item.itemId != LISTEN_FROM_HERE) return wrapped.onActionItemClicked(mode, item)
            // Asked before the menu closes, which clears the selection.
            evaluateJavascript("window.lionNarration && lionNarration.selectedParagraph()") { result
                ->
                result?.toIntOrNull()?.let { paragraph -> onListenFrom?.invoke(paragraph) }
                mode.finish()
            }
            return true
        }

        override fun onDestroyActionMode(mode: ActionMode) = wrapped.onDestroyActionMode(mode)

        // Where the floating toolbar goes: the WebView's own answer.
        override fun onGetContentRect(mode: ActionMode, view: View, outRect: Rect) {
            if (wrapped is ActionMode.Callback2) wrapped.onGetContentRect(mode, view, outRect)
            else super.onGetContentRect(mode, view, outRect)
        }
    }

    fun highlight(paragraph: Int?, autoScroll: Boolean) {
        wanted = paragraph
        scroll = autoScroll
        if (!pageReady || rendererLost || shown == paragraph) return
        shown = paragraph
        evaluateJavascript(
            "window.lionNarration && " +
                "lionNarration.highlight(${paragraph ?: "null"}, $autoScroll, $smoothScroll)",
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
    /** This gesture is a scroll kept from the pager (not a sideways one). */
    private var scrolling = false
    /** This gesture is a page turn: the WebView's own handling of it was cancelled. */
    private var turning = false
    private val longPress = ViewConfiguration.getLongPressTimeout()

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
                scrolling = false
                turning = false
            }
            // Two fingers aren't a page turn.
            MotionEvent.ACTION_POINTER_DOWN -> if (deciding) keep()
            MotionEvent.ACTION_MOVE -> {
                if (deciding) {
                    val index = event.findPointerIndex(pointerId)
                    if (index >= 0)
                        decide(event.getX(index) - downX, abs(event.getY(index) - downY))
                }
                if (
                    pageScrolling &&
                        scrolling &&
                        !turning &&
                        event.eventTime - event.downTime < longPress
                ) {
                    turning = true
                    val cancel =
                        MotionEvent.obtain(event).apply { action = MotionEvent.ACTION_CANCEL }
                    super.onTouchEvent(cancel)
                    cancel.recycle()
                }
            }
            MotionEvent.ACTION_UP -> {
                deciding = false
                if (turning) {
                    turning = false
                    // A finger moving up moves down the page.
                    val index = event.findPointerIndex(pointerId)
                    val y = if (index >= 0) event.getY(index) else event.y
                    turnPage(if (y < downY) 1 else -1)
                    return true
                }
            }
            MotionEvent.ACTION_CANCEL -> {
                deciding = false
                turning = false
            }
        }
        return turning || super.onTouchEvent(event)
    }

    /**
     * Moves the page [PAGE_FRACTION] of the screen down (1) or up (-1), at once; false unlaid out.
     */
    fun turnPage(direction: Int): Boolean {
        if (height == 0 || rendererLost) return false
        val bottom = (computeVerticalScrollRange() - height).coerceAtLeast(0)
        val step = (height * PAGE_FRACTION).toInt()
        scrollTo(scrollX, (scrollY + direction * step).coerceIn(0, bottom))
        return true
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
                abs(dx) < dy * SWIPE_RATIO -> true.also { scrolling = true }
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

private const val LISTEN_FROM_HERE = 0x4c52

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
private class ReaderWebViewClient(
    private val assets: WebViewAssetLoader,
    private val onRendererLost: (crashed: Boolean) -> Unit,
) : WebViewClient() {
    override fun shouldInterceptRequest(
        view: WebView,
        request: WebResourceRequest,
    ): WebResourceResponse? = assets.shouldInterceptRequest(request.url)

    override fun onPageFinished(view: WebView, url: String?) {
        (view as? ReaderView)?.onLoaded()
    }

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
    // whole app down. Compose owns the view, so it's replaced there
    // (ReaderWebView), which destroys this one.
    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
        (view as? ReaderView)?.rendererLost = true
        onRendererLost(detail.didCrash())
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

/** Where the bundled fonts and scripts are served from (the WebView's asset loader). */
const val ASSET_ORIGIN = "https://appassets.androidplatform.net"

/** The reader's sizing shared with the web, from the bundled `reader/appearance.json`. */
fun appearanceTokens(context: Context): AppearanceTokens =
    AppearanceTokens.parse(
        context.assets.open("reader/appearance.json").bufferedReader().use { it.readText() }
    )
