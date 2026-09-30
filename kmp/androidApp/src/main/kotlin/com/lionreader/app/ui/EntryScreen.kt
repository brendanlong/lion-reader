package com.lionreader.app.ui

import android.content.Intent
import android.text.format.DateUtils
import android.widget.Toast
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.lionreader.app.AccountSession
import com.lionreader.app.AppGraph
import com.lionreader.app.R
import com.lionreader.app.narration.NarratedArticle
import com.lionreader.app.narration.NarrationState
import com.lionreader.app.reader.AppearanceTokens
import com.lionreader.app.reader.ReaderColors
import com.lionreader.app.reader.ReaderHeader
import com.lionreader.app.reader.ReaderNarration
import com.lionreader.app.reader.ReaderWebView
import com.lionreader.app.reader.readerDocument
import com.lionreader.shared.data.EntryDetail
import com.lionreader.shared.data.Reader
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
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
    onOpenElsewhere: (NarrationState) -> Unit,
) {
    val context = LocalContext.current
    val pages = remember(startId) { if (startId in ids) ids else listOf(startId) }
    val pager = rememberPagerState(initialPage = pages.indexOf(startId)) { pages.size }
    val entryId = pages[pager.settledPage]
    // Each page reports its entry, so the top bar can follow the page a swipe
    // is heading to (not the one it settles on) with that page's state
    // already loaded.
    val entries = remember { mutableStateMapOf<String, EntryDetail>() }
    // What each page's reader extracted to narrate.
    val spoken = remember { mutableStateMapOf<String, List<String>>() }
    val narration by graph.narrator.state.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) {
        graph.narrator.errors.collect { Toast.makeText(context, it, Toast.LENGTH_LONG).show() }
    }
    // When narration moves on to the next article, turn the page with it, if
    // the reader was on the article it just finished.
    var narratedBefore by remember { mutableStateOf(narration?.entryId) }
    LaunchedEffect(narration?.entryId) {
        val now = narration?.entryId
        val before = narratedBefore
        // First: the animation throws if a drag interrupts it.
        narratedBefore = now
        val shown = pages[pager.settledPage]
        if (now != null && before == shown && now != shown) {
            pages.indexOf(now).takeIf { it >= 0 }?.let { pager.animateScrollToPage(it) }
        }
    }
    val settings by graph.currentSettings.collectAsStateWithLifecycle()
    val entry = entries[pages[pager.targetPage]]
    val coroutines = rememberCoroutineScope()
    val tokens = remember { AppearanceTokens.load(context) }
    // Null while unknown (e.g. offline): only summaries already on the device show then.
    val summariesAvailable by produceState<Boolean?>(null) { value = account.summariesAvailable() }
    var hiddenSummaries by rememberSaveable { mutableStateOf(emptySet<String>()) }
    var summarizing by remember { mutableStateOf(emptySet<String>()) }

    MarkReadOnArrival(account.reader, entryId, onShown)

    Scaffold(
        topBar = {
            TopAppBar(
                title = {},
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
                actions = {
                    val current = entry ?: return@TopAppBar
                    val paragraphs = spoken[current.id]
                    if (!paragraphs.isNullOrEmpty() && narration?.entryId != current.id) {
                        IconButton(
                            onClick = {
                                graph.narrator.narrate(
                                    NarratedArticle(
                                        current.id,
                                        current.title ?: "Untitled",
                                        current.source,
                                        paragraphs,
                                        queue = pages,
                                    )
                                )
                            }
                        ) {
                            Icon(
                                painterResource(R.drawable.ic_headphones),
                                contentDescription = "Listen",
                            )
                        }
                    }
                    // It shows in the article, so not before the article is on the device.
                    if (
                        current.content != null &&
                            (summariesAvailable == true || current.summary != null)
                    ) {
                        SummaryButton(
                            summarizing = current.id in summarizing,
                            hasSummary = current.summary != null,
                            shown = current.id !in hiddenSummaries,
                        ) {
                            val id = current.id
                            if (current.summary != null) {
                                hiddenSummaries =
                                    if (id in hiddenSummaries) hiddenSummaries - id
                                    else hiddenSummaries + id
                            } else if (id !in summarizing) {
                                summarizing += id
                                hiddenSummaries -= id
                                coroutines.launch {
                                    try {
                                        withContext(Dispatchers.IO) { account.sync.summarize(id) }
                                    } catch (e: CancellationException) {
                                        throw e
                                    } catch (_: Exception) {
                                        Toast.makeText(
                                                context,
                                                "Couldn't summarize this article",
                                                Toast.LENGTH_SHORT,
                                            )
                                            .show()
                                    } finally {
                                        summarizing -= id
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
                        Icon(
                            painterResource(
                                if (current.read) R.drawable.ic_circle_outline
                                else R.drawable.ic_circle
                            ),
                            contentDescription = if (current.read) "Mark unread" else "Mark read",
                            tint = actionTint(active = !current.read),
                            // The list's size: a full-size filled dot outweighs
                            // the outline icons beside it.
                            modifier = Modifier.size(16.dp),
                        )
                    }
                    IconButton(
                        onClick = {
                            coroutines.launch {
                                account.reader.setStarred(current.id, !current.starred)
                            }
                        }
                    ) {
                        Icon(
                            painterResource(
                                if (current.starred) R.drawable.ic_star
                                else R.drawable.ic_star_border
                            ),
                            contentDescription = if (current.starred) "Unstar" else "Star",
                            tint = actionTint(active = current.starred),
                        )
                    }
                    current.url?.let { url ->
                        IconButton(
                            onClick = {
                                context.startActivity(
                                    Intent.createChooser(
                                        Intent(Intent.ACTION_SEND)
                                            .setType("text/plain")
                                            .putExtra(Intent.EXTRA_TEXT, url)
                                            .putExtra(Intent.EXTRA_SUBJECT, current.title),
                                        null,
                                    )
                                )
                            }
                        ) {
                            Icon(painterResource(R.drawable.ic_share), contentDescription = "Share")
                        }
                        IconButton(
                            onClick = {
                                context.startActivity(Intent(Intent.ACTION_VIEW, url.toUri()))
                            }
                        ) {
                            Icon(
                                painterResource(R.drawable.ic_open_in_new),
                                contentDescription = "Open original",
                            )
                        }
                    }
                },
            )
        },
        bottomBar = {
            // Another article's narration opens it; this one's is already here.
            CurrentNarrationBar(
                graph,
                // Nothing to open when it's the article on screen.
                onOpen =
                    if (narration?.entryId == entryId) null
                    else
                        { state ->
                            pages
                                .indexOf(state.entryId)
                                .takeIf { it >= 0 }
                                ?.let { page ->
                                    coroutines.launch { pager.animateScrollToPage(page) }
                                } ?: onOpenElsewhere(state)
                        },
            )
        },
    ) { padding ->
        HorizontalPager(
            state = pager,
            key = { pages[it] },
            modifier = Modifier.padding(padding).fillMaxSize(),
        ) { page ->
            EntryPage(
                graph,
                account,
                pages[page],
                tokens,
                showSummary = pages[page] !in hiddenSummaries,
                onEntry = { id, loaded ->
                    if (loaded == null) {
                        entries.remove(id)
                        spoken.remove(id)
                    } else {
                        entries[id] = loaded
                    }
                },
                narration =
                    ReaderNarration(
                        paragraph = narration?.takeIf { it.entryId == pages[page] }?.paragraph,
                        autoScroll = settings.narrationAutoScroll,
                        onParagraphs = { spoken[pages[page]] = it },
                        // Only while this article is the one being narrated.
                        onSeek = { paragraph ->
                            if (graph.narrator.state.value?.entryId == pages[page]) {
                                graph.narrator.seekToParagraph(paragraph)
                            }
                        },
                    ),
            )
        }
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
        val shown = reader.entry(entryId).first() ?: return@LaunchedEffect
        if (!shown.read) reader.setRead(listOf(entryId), true)
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
) {
    val context = LocalContext.current
    val entry by
        remember(entryId) { account.reader.entry(entryId) }.collectAsStateWithLifecycle(null)
    // Null once it's gone (e.g. deleted), and when the page leaves: the top
    // bar shows only what's on a page now.
    LaunchedEffect(entry) { onEntry(entryId, entry) }
    DisposableEffect(entryId) { onDispose { onEntry(entryId, null) } }
    val settings by graph.currentSettings.collectAsStateWithLifecycle()
    val download =
        rememberBodyDownload(entryId, entry) {
            withContext(Dispatchers.IO) { account.sync.ensureContent(entryId) }
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
    val content = current.content
    if (content != null) {
        val colors = MaterialTheme.colorScheme
        val document =
            readerDocument(
                header = ReaderHeader(title, byline),
                summary = current.summary?.takeIf { showSummary },
                body = content,
                settings = settings,
                tokens = tokens,
                colors =
                    ReaderColors(
                        text = colors.onSurface.css(),
                        muted = colors.onSurfaceVariant.css(),
                        link = colors.primary.css(),
                        background = colors.surface.css(),
                        border = colors.outlineVariant.css(),
                        codeBackground = colors.surfaceContainer.css(),
                    ),
            )
        ReaderWebView(document, Modifier.fillMaxSize(), narration)
        return
    }
    Column(
        modifier =
            Modifier.fillMaxSize()
                .verticalScroll(rememberScrollState())
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
