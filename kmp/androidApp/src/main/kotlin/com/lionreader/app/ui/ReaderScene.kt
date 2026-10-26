package com.lionreader.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.navigation3.runtime.NavEntry
import androidx.navigation3.runtime.NavKey
import androidx.navigation3.scene.Scene
import androidx.navigation3.scene.SceneStrategy
import androidx.navigation3.scene.SceneStrategyScope

/** SPIKE: marks the list's and article's entries for [ReaderSceneStrategy]. */
internal const val READER_ROLE = "lionReaderRole"

/**
 * SPIKE: the list, with the article over it when one is open, as one scene whatever the back
 * stack's top: NavDisplay only rebuilds and animates on a scene change, so the article layer stays
 * composed, with its WebViews attached, between opens.
 */
internal class ReaderSceneStrategy(private val article: @Composable () -> Unit) :
    SceneStrategy<NavKey> {
    override fun SceneStrategyScope<NavKey>.calculateScene(
        entries: List<NavEntry<NavKey>>
    ): Scene<NavKey>? {
        val home =
            entries.firstOrNull()?.takeIf { it.metadata[READER_ROLE] == "home" } ?: return null
        if (entries.size > 2) return null
        if (entries.size == 2 && entries[1].metadata[READER_ROLE] != "article") return null
        return ReaderScene(entries, entries.dropLast(1), home, article)
    }
}

private class ReaderScene(
    override val entries: List<NavEntry<NavKey>>,
    override val previousEntries: List<NavEntry<NavKey>>,
    private val home: NavEntry<NavKey>,
    private val article: @Composable () -> Unit,
) : Scene<NavKey> {
    override val key: Any = "reader"
    override val content: @Composable () -> Unit = {
        Box(Modifier.fillMaxSize()) {
            Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
                home.Content()
            }
            article()
        }
    }
}
