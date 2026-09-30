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
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
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
import com.lionreader.app.reader.AppearanceTokens
import com.lionreader.app.reader.ReaderColors
import com.lionreader.app.reader.ReaderHeader
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
) {
    val context = LocalContext.current
    val pages = remember(startId) { if (startId in ids) ids else listOf(startId) }
    val pager = rememberPagerState(initialPage = pages.indexOf(startId)) { pages.size }
    val entryId = pages[pager.settledPage]
    // Each page reports its entry, so the top bar can follow the page a swipe
    // is heading to (not the one it settles on) with that page's state
    // already loaded.
    val entries = remember { mutableStateMapOf<String, EntryDetail>() }
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
                        Icon(painterResource(R.drawable.ic_arrow_back), contentDescription = "Back")
                    }
                },
                actions = {
                    val current = entry ?: return@TopAppBar
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
        }
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
                onEntry = { entries[it.id] = it },
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
    onEntry: (EntryDetail) -> Unit,
) {
    val context = LocalContext.current
    val entry by
        remember(entryId) { account.reader.entry(entryId) }.collectAsStateWithLifecycle(null)
    LaunchedEffect(entry) { entry?.let(onEntry) }
    val settings by graph.currentSettings.collectAsStateWithLifecycle()
    var loadFailed by remember(entryId) { mutableStateOf(false) }

    LaunchedEffect(entryId, entry?.content == null) {
        loadFailed = false
        if (entry != null && entry?.content == null) {
            loadFailed =
                try {
                    !withContext(Dispatchers.IO) { account.sync.ensureContent(entryId) }
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    true
                }
        }
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
        ReaderWebView(document, modifier = Modifier.fillMaxSize())
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
        if (loadFailed) {
            Text(
                "This article hasn't been downloaded yet. Connect to the internet to read it.",
                modifier = Modifier.padding(vertical = 16.dp),
            )
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

/** Top-bar icons: amber for an active state (unread, starred, summary shown), like the list. */
@Composable
private fun actionTint(active: Boolean): Color =
    if (active) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant

private fun Color.css(): String = "#%06X".format(toArgb() and 0xFFFFFF)
