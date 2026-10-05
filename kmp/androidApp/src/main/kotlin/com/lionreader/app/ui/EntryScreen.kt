package com.lionreader.app.ui

import android.text.format.DateUtils
import android.widget.Toast
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.spring
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.PagerDefaults
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalViewConfiguration
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.compose.currentStateAsState
import androidx.lifecycle.repeatOnLifecycle
import com.lionreader.app.AppGraph
import com.lionreader.app.R
import com.lionreader.app.openWebPage
import com.lionreader.app.reader.ASSET_ORIGIN
import com.lionreader.app.reader.ReaderNarration
import com.lionreader.app.reader.ReaderPaging
import com.lionreader.app.reader.ReaderWebView
import com.lionreader.app.reader.ReadingPosition
import com.lionreader.app.reader.appearanceTokens
import com.lionreader.app.reader.pagerViewConfiguration
import com.lionreader.app.shareWebPage
import com.lionreader.shared.account.AccountSession
import com.lionreader.shared.api.apiFailure
import com.lionreader.shared.data.ArticleState
import com.lionreader.shared.data.EntryDetail
import com.lionreader.shared.data.Reader
import com.lionreader.shared.links.webUrl
import com.lionreader.shared.narration.NarratedArticle
import com.lionreader.shared.narration.NarrationState
import com.lionreader.shared.reader.AppearanceTokens
import com.lionreader.shared.reader.ReaderColors
import com.lionreader.shared.reader.ReaderHeader
import com.lionreader.shared.reader.readerDocument
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Articles of the list they were opened from, one per page: swiping left or right moves to the next
 * or previous one, and each is marked read when it settles on screen. [ids] is the list's order
 * when the screen opened, kept fixed so entries arriving meanwhile don't shift the pages.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EntryScreen(
    graph: AppGraph,
    account: AccountSession,
    ids: List<String>,
    startId: String,
    onShown: (String) -> Unit,
    onBack: () -> Unit,
    /** Beside the list, where going back closes the article rather than leaving it. */
    besideList: Boolean,
) {
    val context = LocalContext.current
    // EntryKey.openedFrom always lists the entry it opens.
    val pages = ids
    val pager = rememberPagerState(initialPage = pages.indexOf(startId)) { pages.size }
    val entryId = pages[pager.settledPage]
    val articles = rememberArticlePages()
    val narration by graph.narrator.state.collectAsStateWithLifecycle()
    // Only while on screen, so a notice from the background waits to be seen.
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            graph.narrator.notice.filterNotNull().collect {
                Toast.makeText(context, it, Toast.LENGTH_LONG).show()
                graph.narrator.noticeShown(it)
            }
        }
    }
    NarrationFollowsPage(
        narration,
        entryId,
        articles.paragraphs(entryId),
        articles.entry(entryId),
        started =
            LocalLifecycleOwner.current.lifecycle
                .currentStateAsState()
                .value
                .isAtLeast(Lifecycle.State.STARTED),
        follow = graph.narrator::follow,
        supply = graph.narrator::supply,
    )
    val settings by graph.currentSettings.collectAsStateWithLifecycle()
    val entry = articles.entry(pages[pager.targetPage])
    val coroutines = rememberCoroutineScope()
    val tokens = remember { appearanceTokens(context) }
    // Null while unknown (e.g. offline): only summaries already on the device show then.
    val summariesAvailable by produceState<Boolean?>(null) { value = account.summariesAvailable() }

    MarkReadOnArrival(account.reader, entryId, onShown)

    val actions: @Composable RowScope.() -> Unit = actions@{
        val current = entry ?: return@actions
        val paragraphs = articles.paragraphs(current.id)
        // Amber while narration is on, like the other toggles; it follows
        // swipes, so tapping it then stops whichever article it's on.
        val narrating = narration != null
        if (narrating || !paragraphs.isNullOrEmpty()) {
            IconButton(
                onClick = {
                    if (narrating) graph.narrator.stop()
                    else if (paragraphs != null)
                        graph.narrator.narrate(NarratedArticle.of(current, paragraphs))
                }
            ) {
                Icon(
                    painterResource(R.drawable.ic_headphones),
                    contentDescription = if (narrating) "Stop listening" else "Listen",
                    tint = actionTint(active = narrating),
                )
            }
        }
        // It shows in the article, so not before the article is on the device.
        if (current.content != null && (summariesAvailable == true || current.summary != null)) {
            SummaryButton(
                summarizing = articles.isSummarizing(current.id),
                hasSummary = current.summary != null,
                shown = articles.summaryShown(current.id),
            ) {
                val id = current.id
                if (current.summary != null) {
                    articles.toggleSummary(id)
                } else if (articles.startSummarizing(id)) {
                    coroutines.launch {
                        try {
                            account.summarize(id)
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            // A 4xx says why (the provider is busy, or rejected the
                            // user's own key).
                            val reason = e.apiFailure().message
                            Toast.makeText(
                                    context,
                                    reason ?: "Couldn't summarize this article",
                                    if (reason != null) Toast.LENGTH_LONG else Toast.LENGTH_SHORT,
                                )
                                .show()
                        } finally {
                            articles.doneSummarizing(id)
                        }
                    }
                }
            }
        }
        IconButton(
            onClick = {
                coroutines.launch {
                    account.reader.setRead(listOf(current.id), !current.read)
                }
            }
        ) {
            ReadToggleIcon(current.read)
        }
        IconButton(
            onClick = {
                coroutines.launch {
                    account.reader.setStarred(current.id, !current.starred)
                }
            }
        ) {
            StarToggleIcon(current.starred)
        }
        webUrl(current.url)?.let { url ->
            IconButton(onClick = { context.shareWebPage(url, current.title) }) {
                Icon(painterResource(R.drawable.ic_share), contentDescription = "Share")
            }
            IconButton(onClick = { context.openWebPage(url) }) {
                Icon(
                    painterResource(R.drawable.ic_open_in_new),
                    contentDescription = "Open original",
                )
            }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                // Empty to the eye; says which article a swipe arrived at.
                title = {
                    Box(
                        Modifier.fillMaxWidth().height(1.dp).semantics {
                            // Once it's loaded, so a slow page isn't announced twice.
                            val shown = articles.entry(entryId) ?: return@semantics
                            liveRegion = LiveRegionMode.Polite
                            heading()
                            contentDescription =
                                "${shown.title ?: "Untitled"}, " +
                                    "${pager.settledPage + 1} of ${pages.size}"
                        }
                    )
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        if (besideList) {
                            Icon(
                                painterResource(R.drawable.ic_close),
                                contentDescription = "Close article",
                            )
                        } else {
                            Icon(
                                painterResource(R.drawable.ic_arrow_back),
                                contentDescription = "Back",
                            )
                        }
                    }
                },
                // Beside the list, the article's actions stay at the top: the bottom is
                // the narration bar's. On a phone they're at the bottom, in reach.
                actions = { if (besideList) actions() },
            )
        },
        bottomBar = {
            if (narration != null || !besideList) {
                Surface(tonalElevation = 3.dp) {
                    Column(Modifier.navigationBarsPadding()) {
                        narration?.let {
                            NarrationBar(
                                state = it,
                                speed = settings.narrationSpeed,
                                onPrevious =
                                    if (it.canSkipBack) {
                                        { graph.narrator.skipParagraphs(-1) }
                                    } else null,
                                onToggle = graph.narrator::togglePlaying,
                                onNext =
                                    if (it.canSkipForward) {
                                        { graph.narrator.skipParagraphs(1) }
                                    } else null,
                                onSpeed = graph::setNarrationSpeed,
                            )
                        }
                        if (!besideList) {
                            Row(
                                // Its height while the article loads, so the page
                                // doesn't jump when the actions arrive.
                                Modifier.fillMaxWidth().heightIn(min = 48.dp),
                                horizontalArrangement = Arrangement.SpaceEvenly,
                                verticalAlignment = Alignment.CenterVertically,
                                content = actions,
                            )
                        }
                    }
                }
            }
        },
    ) { padding ->
        val pageConfig = LocalViewConfiguration.current
        // The pager waits for a bigger drag, so the reader decides first (pagerViewConfiguration).
        CompositionLocalProvider(LocalViewConfiguration provides pagerViewConfiguration()) {
            HorizontalPager(
                state = pager,
                key = { pages[it] },
                // The neighbours are ready before a swipe: creating a page's
                // WebView mid-swipe blanks the one on screen for a frame, and
                // the next page's narration (its Listen button) comes from its
                // WebView having loaded.
                beyondViewportPageCount = 1,
                // A fling's snap runs at its own speed, which the app's animation scale doesn't
                // reach (AppMotion): without animations, it lands at once.
                flingBehavior =
                    PagerDefaults.flingBehavior(
                        pager,
                        snapAnimationSpec = if (settings.animations) spring() else snap(),
                    ),
                modifier = Modifier.padding(padding).fillMaxSize(),
            ) { page ->
                CompositionLocalProvider(LocalViewConfiguration provides pageConfig) {
                    EntryPage(
                        graph,
                        account,
                        pages[page],
                        tokens,
                        showSummary = articles.summaryShown(pages[page]),
                        onEntry = articles::loaded,
                        narration =
                            ReaderNarration(
                                paragraph =
                                    narration?.takeIf { it.entryId == pages[page] }?.paragraph,
                                autoScroll = settings.narrationAutoScroll,
                                onParagraphs = { articles.extracted(pages[page], it) },
                                onListenFrom = { paragraph ->
                                    listenFrom(graph, articles, pages[page], paragraph)
                                },
                                // Only while this article is the one being narrated.
                                onSeek = { paragraph ->
                                    if (graph.narrator.state.value?.entryId == pages[page]) {
                                        graph.narrator.seekToParagraph(paragraph)
                                    }
                                },
                            ),
                        // The volume buttons turn the page on screen, not its neighbours'.
                        active = page == pager.currentPage,
                    )
                }
            }
        }
    }
}

/**
 * "Listen" on a selection in [entryId], at [paragraph]
 * ([com.lionreader.app.narration.Narrator.listenFrom]).
 */
private fun listenFrom(graph: AppGraph, articles: ArticlePages, entryId: String, paragraph: Int) {
    val entry = articles.entry(entryId) ?: return
    val paragraphs = articles.paragraphs(entryId) ?: return
    graph.narrator.listenFrom(NarratedArticle.of(entry, paragraphs), paragraph)
}

/**
 * Narration, while on, is of the article on screen: when the pager moves to another, what's playing
 * stops at once and narration follows it, playing or paused as it was. Its text is supplied once
 * the page has it and has stayed for [settle] (so swiping past articles doesn't synthesize, and
 * with cloud voices pay for, each). Only while the app is on screen: a switch empties the player,
 * and media3 can't bring its foreground service back from the background.
 */
@Composable
internal fun NarrationFollowsPage(
    narration: NarrationState?,
    entryId: String,
    paragraphs: List<String>?,
    entry: EntryDetail?,
    started: Boolean,
    follow: (entryId: String, title: String) -> Unit,
    supply: (NarratedArticle) -> Unit,
    settle: Long = 1_000,
) {
    val on = narration != null
    LaunchedEffect(on, entryId, entry?.title, started) {
        if (on && started) follow(entryId, entry?.title ?: "")
    }
    val current by rememberUpdatedState(entry)
    val following = narration?.entryId == entryId
    LaunchedEffect(following, entryId, paragraphs, entry == null, started) {
        if (!following || paragraphs == null || !started) return@LaunchedEffect
        delay(settle)
        val shown = current ?: return@LaunchedEffect
        supply(NarratedArticle.of(shown, paragraphs))
    }
}

/**
 * Marks the entry the pager settles on read, once per arrival. A restored screen (rotation, process
 * death) is still on the same arrival, so an entry the user marked unread stays unread; swiping
 * away and back is a new one.
 */
@Composable
internal fun MarkReadOnArrival(reader: Reader, entryId: String, onShown: (String) -> Unit) {
    var marked by rememberSaveable { mutableStateOf<String?>(null) }
    LaunchedEffect(entryId) {
        onShown(entryId)
        if (marked == entryId) return@LaunchedEffect
        marked = entryId
        reader.markOpened(entryId)
        // Even if it's read already, like the web, so it's at the top of Recently Read.
        reader.setRead(listOf(entryId), true)
    }
}

@Composable
private fun EntryPage(
    graph: AppGraph,
    account: AccountSession,
    entryId: String,
    tokens: AppearanceTokens,
    showSummary: Boolean,
    onEntry: (String, EntryDetail?) -> Unit,
    narration: ReaderNarration,
    active: Boolean,
) {
    val context = LocalContext.current
    val article by
        remember(entryId) { account.reader.article(entryId) }.collectAsStateWithLifecycle(null)
    val entry = (article as? ArticleState.Shown)?.entry
    // Up here, so it outlasts the page showing no article for a while (e.g. a fresh sync).
    val position = rememberSaveable(entryId, saver = ReadingPosition.Saver) { ReadingPosition() }
    // Null once it's gone (e.g. deleted) or can't be read, and when the page
    // leaves: the top bar shows only what's on a page now.
    LaunchedEffect(entry) { onEntry(entryId, entry) }
    DisposableEffect(entryId) { onDispose { onEntry(entryId, null) } }
    val settings by graph.currentSettings.collectAsStateWithLifecycle()
    val download =
        rememberBodyDownload(entryId, entry) {
            withContext(Dispatchers.IO) { account.sync.ensureContent(entryId) }
        }

    if (article == ArticleState.Unreadable) {
        Text(
            "Lion Reader couldn't open this article. It may be too large for this device.",
            modifier = Modifier.fillMaxSize().padding(16.dp),
        )
        return
    }
    val current = entry ?: return
    val byline =
        listOfNotNull(
                current.source,
                // Like the web, the author is left out when it's the feed's name.
                current.author?.takeUnless {
                    it.trim().equals(current.source?.trim(), ignoreCase = true)
                },
                DateUtils.formatDateTime(
                    context,
                    current.sortAtMillis,
                    DateUtils.FORMAT_SHOW_DATE or DateUtils.FORMAT_SHOW_YEAR,
                ),
            )
            .joinToString(" · ")
    val title = current.title ?: "Untitled"
    val content = rememberShownBody(entryId, current.content)
    if (content != null) {
        val colors = MaterialTheme.colorScheme
        val readerColors =
            ReaderColors(
                text = colors.onSurface.css(),
                muted = colors.onSurfaceVariant.css(),
                link = colors.primary.css(),
                background = colors.surface.css(),
                border = colors.outlineVariant.css(),
                codeBackground = colors.surfaceContainer.css(),
            )
        val header = ReaderHeader(title, byline, current.url)
        val summary = current.summary?.takeIf { showSummary }
        // Not rebuilt on every recomposition (each narration step is one).
        val document =
            remember(header, summary, content, settings, tokens, readerColors) {
                readerDocument(
                    header,
                    summary,
                    content,
                    settings,
                    tokens,
                    readerColors,
                    ASSET_ORIGIN,
                )
            }
        ReaderWebView(
            document,
            position,
            Modifier.fillMaxSize(),
            narration,
            ReaderPaging(
                swipes = settings.pageScrolling,
                turns = graph.pageTurns.takeIf { active },
                smoothScroll = settings.animations,
            ),
        )
        return
    }
    val scroll = rememberScrollState()
    Column(
        modifier =
            Modifier.fillMaxSize()
                .pageSwipes(
                    rememberPageTurner(scroll, graph.pageTurns, PageLayer.ARTICLE, active),
                    settings.pageScrolling,
                )
                .scrollbar { scroll.scrollIndicatorState }
                .verticalScroll(scroll, enabled = !settings.pageScrolling)
                .padding(horizontal = 16.dp, vertical = 8.dp)
    ) {
        Text(title, style = MaterialTheme.typography.headlineSmall)
        Text(
            byline,
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(top = 4.dp),
        )
        if (download.failed) {
            Text(
                "This article hasn't been downloaded yet. Connect to the internet to read it.",
                modifier = Modifier.padding(top = 16.dp),
            )
            TextButton(onClick = download.retry) { Text("Retry") }
        } else {
            CircularProgressIndicator(modifier = Modifier.padding(vertical = 32.dp))
        }
    }
}

@Composable
private fun SummaryButton(
    summarizing: Boolean,
    hasSummary: Boolean,
    shown: Boolean,
    onClick: () -> Unit,
) {
    IconButton(onClick = onClick, enabled = !summarizing) {
        if (summarizing) {
            CircularProgressIndicator(
                modifier = Modifier.size(20.dp).semantics { contentDescription = "Summarizing" },
                strokeWidth = 2.dp,
            )
        } else {
            Icon(
                painterResource(R.drawable.ic_sparkles),
                contentDescription =
                    when {
                        !hasSummary -> "Summarize"
                        shown -> "Hide summary"
                        else -> "Show summary"
                    },
                tint = actionTint(active = hasSummary && shown),
            )
        }
    }
}

/**
 * The body to show: [content], or while it's missing, the one shown before. An edited article's
 * body is deleted until it's downloaded again (SyncWriter), and an unchanged one mustn't take the
 * page down to a spinner and back, reloading it, meanwhile. If that download fails, the old body
 * stays rather than the failure showing: it's still the article.
 */
@Composable
internal fun rememberShownBody(entryId: String, content: String?): String? {
    val shown = remember(entryId) { arrayOfNulls<String>(1) }
    if (content != null) shown[0] = content
    return shown[0]
}

/** Whether the page's body download failed, and a way to try it again. */
internal class BodyDownload(val failed: Boolean, val retry: () -> Unit)

/**
 * Downloads the entry's body when it's loaded without one. Keyed on "loaded and missing", because
 * the entry is null until its query answers: keyed on a missing body alone, the effect would run
 * against the null entry and not again when it loads. Nothing else fetches it, either: opening an
 * entry marks it read, and the background download skips read entries.
 */
@Composable
internal fun rememberBodyDownload(
    entryId: String,
    entry: EntryDetail?,
    download: suspend () -> Boolean,
): BodyDownload {
    val missing = entry != null && entry.content == null
    var failed by remember(entryId) { mutableStateOf(false) }
    var attempt by remember(entryId) { mutableIntStateOf(0) }
    val currentDownload by rememberUpdatedState(download)
    LaunchedEffect(entryId, missing, attempt) {
        failed = false
        if (!missing) return@LaunchedEffect
        failed =
            try {
                !currentDownload()
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                true
            }
    }
    return BodyDownload(failed) { attempt++ }
}

private fun Color.css(): String = "#%06X".format(toArgb() and 0xFFFFFF)
