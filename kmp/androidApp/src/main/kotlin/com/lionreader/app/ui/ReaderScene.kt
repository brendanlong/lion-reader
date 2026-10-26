package com.lionreader.app.ui

import androidx.activity.compose.PredictiveBackHandler
import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.background
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.zIndex
import androidx.navigation3.runtime.NavEntry
import androidx.navigation3.runtime.NavKey
import androidx.navigation3.scene.Scene
import androidx.navigation3.scene.SceneStrategy
import androidx.navigation3.scene.SceneStrategyScope
import com.lionreader.app.EntryKey
import kotlinx.coroutines.CancellationException
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
    var drawn by remember { mutableStateOf<EntryKey?>(null) }
    val shown = open != null && open == drawn
    // How far the article is from being on screen: 0 there, 1 behind the list.
    val away = remember { Animatable(1f) }
    LaunchedEffect(shown, animate) {
        val target = if (shown) 0f else 1f
        if (animate) away.animateTo(target, screenChangeSpec()) else away.snapTo(target)
    }
    val coroutines = rememberCoroutineScope()
    PredictiveBackHandler(enabled = shown) { gesture ->
        try {
            gesture.collect { away.snapTo(it.progress) }
            onBack()
        } catch (e: CancellationException) {
            coroutines.launch { away.animateTo(0f, screenChangeSpec()) }
            throw e
        }
    }
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
                )
        ) {
            article(open ?: drawn, shown) { drawn = it }
        }
    }
}
