package com.lionreader.app.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.background
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.zIndex
import androidx.navigation3.runtime.NavEntry
import androidx.navigation3.runtime.NavKey
import androidx.navigation3.scene.Scene
import androidx.navigation3.scene.SceneStrategy
import androidx.navigation3.scene.SceneStrategyScope
import androidx.navigationevent.NavigationEvent
import androidx.navigationevent.NavigationEventDispatcher
import androidx.navigationevent.NavigationEventHandler
import androidx.navigationevent.NavigationEventInfo
import androidx.navigationevent.compose.LocalNavigationEventDispatcherOwner
import com.lionreader.app.EntryKey
import kotlinx.coroutines.launch

/** Metadata marking the list's and the article's back stack entries for [ReaderSceneStrategy]. */
internal const val READER_LIST = "lionReader.list"
internal const val READER_ARTICLE = "lionReader.article"

/**
 * On a phone, the list with the article over it while one is open, as one scene whatever the back
 * stack's top: NavDisplay rebuilds and animates only on a scene change, so the article layer
 * ([ArticleLayer], in [content]) stays composed, its pages' WebViews attached, while the list
 * shows. [content] gets the list's entry to show under it.
 */
internal class ReaderSceneStrategy(
    private val content: @Composable (list: @Composable () -> Unit) -> Unit
) : SceneStrategy<NavKey> {
    override fun SceneStrategyScope<NavKey>.calculateScene(
        entries: List<NavEntry<NavKey>>
    ): Scene<NavKey>? {
        val list = entries.firstOrNull()?.takeIf { READER_LIST in it.metadata } ?: return null
        val article = entries.drop(1)
        if (article.size > 1 || article.any { READER_ARTICLE !in it.metadata }) return null
        return ReaderScene(entries, entries.dropLast(1)) { content { list.Content() } }
    }
}

private class ReaderScene(
    override val entries: List<NavEntry<NavKey>>,
    override val previousEntries: List<NavEntry<NavKey>>,
    override val content: @Composable () -> Unit,
) : Scene<NavKey> {
    override val key: Any = ReaderScene::class

    // The same entries are the same scene; content is made anew from them each time.
    override fun equals(other: Any?): Boolean =
        other is ReaderScene && entries == other.entries && previousEntries == other.previousEntries

    override fun hashCode(): Int = 31 * entries.hashCode() + previousEntries.hashCode()
}

/**
 * The [list], and the article over it once [open]'s page has drawn it, never a frame of the last
 * article. Waiting, the article ([article]: the article to show, whether it's [shown], and what to
 * tell once the page on screen has drawn it) is behind the list: composed and drawn, so it's ready
 * at once, but out of reach of touch, accessibility services and focus. It slides in and out as a
 * screen change does, and follows the predictive back gesture.
 */
@Composable
internal fun ArticleLayer(
    open: EntryKey?,
    animate: Boolean,
    onBack: () -> Unit,
    list: @Composable () -> Unit,
    article: @Composable (opened: EntryKey?, shown: Boolean, onReady: (EntryKey) -> Unit) -> Unit,
) {
    // A new layer (rotation, a restored process) shows what's open at once: its pages are new, so
    // there's no last article to flash.
    var drawn by remember { mutableStateOf(open) }
    val shown = open != null && open == drawn
    // How far the article is from being on screen: 0 there, 1 behind the list.
    val away = remember { Animatable(1f) }
    LaunchedEffect(shown, animate) {
        val target = if (shown) 0f else 1f
        if (animate) away.animateTo(target, screenChangeSpec()) else away.snapTo(target)
    }
    val coroutines = rememberCoroutineScope()
    val onTop = shown || away.value < 1f
    Box(Modifier.fillMaxSize()) {
        Box(
            Modifier.fillMaxSize()
                .graphicsLayer { translationX = -(1f - away.value) * COVERED_DRIFT * size.width }
                .background(MaterialTheme.colorScheme.background)
        ) {
            list()
        }
        Box(
            Modifier.fillMaxSize()
                .zIndex(if (onTop) 1f else -1f)
                .graphicsLayer { translationX = if (onTop) away.value * size.width else 0f }
                .then(
                    if (shown) Modifier
                    else
                        Modifier.clearAndSetSemantics {}
                            .focusProperties { onEnter = { cancelFocusChange() } }
                            .focusGroup()
                            .pointerInput(Unit) {
                                awaitPointerEventScope {
                                    while (true) {
                                        awaitPointerEvent(PointerEventPass.Initial)
                                            .changes
                                            .forEach {
                                                it.consume()
                                            }
                                    }
                                }
                            }
                )
        ) {
            article(open ?: drawn, shown) { drawn = it }
            ArticleBackHandler(
                enabled = shown,
                onProgress = { coroutines.launch { away.snapTo(it) } },
                onCancelled = { coroutines.launch { away.animateTo(0f, screenChangeSpec()) } },
                onBack = onBack,
            )
        }
    }
}

/**
 * Back for the article over the list, as an overlay's: ahead of the list's own (its search's, say)
 * and NavDisplay's, whatever order they were added in. [onProgress] follows the predictive back
 * gesture (0 to 1), and [onCancelled] hears it let go.
 */
@Composable
private fun ArticleBackHandler(
    enabled: Boolean,
    onProgress: (Float) -> Unit,
    onCancelled: () -> Unit,
    onBack: () -> Unit,
) {
    val dispatcher =
        checkNotNull(LocalNavigationEventDispatcherOwner.current).navigationEventDispatcher
    val progress by rememberUpdatedState(onProgress)
    val cancelled by rememberUpdatedState(onCancelled)
    val back by rememberUpdatedState(onBack)
    val handler = remember {
        object :
            NavigationEventHandler<NavigationEventInfo>(
                NavigationEventInfo.None,
                isBackEnabled = false,
            ) {
            override fun onBackProgressed(event: NavigationEvent) = progress(event.progress)

            override fun onBackCancelled() = cancelled()

            override fun onBackCompleted() = back()
        }
    }
    SideEffect { handler.isBackEnabled = enabled }
    DisposableEffect(dispatcher, handler) {
        dispatcher.addHandler(handler, NavigationEventDispatcher.PRIORITY_OVERLAY)
        onDispose { handler.remove() }
    }
}
