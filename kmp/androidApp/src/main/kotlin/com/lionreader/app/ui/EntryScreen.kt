package com.lionreader.app.ui

import android.content.Intent
import android.text.format.DateUtils
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
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
    val entry by
        remember(entryId) { account.reader.entry(entryId) }.collectAsStateWithLifecycle(null)
    val coroutines = rememberCoroutineScope()
    val tokens = remember { AppearanceTokens.load(context) }

    LaunchedEffect(entryId) {
        onShown(entryId)
        account.reader.markOpened(entryId)
        val shown = account.reader.entry(entryId).first() ?: return@LaunchedEffect
        if (!shown.read) account.reader.setRead(listOf(entryId), true)
    }

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
                            tint =
                                if (current.starred) MaterialTheme.colorScheme.primary
                                else MaterialTheme.colorScheme.onSurfaceVariant,
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
            EntryPage(graph, account, pages[page], tokens)
        }
    }
}

@Composable
private fun EntryPage(
    graph: AppGraph,
    account: AccountSession,
    entryId: String,
    tokens: AppearanceTokens,
) {
    val context = LocalContext.current
    val entry by
        remember(entryId) { account.reader.entry(entryId) }.collectAsStateWithLifecycle(null)
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

private fun Color.css(): String = "#%06X".format(toArgb() and 0xFFFFFF)
