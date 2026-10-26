package com.lionreader.app.ui

import androidx.compose.material3.Text
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.test.espresso.Espresso
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.lionreader.app.EntryKey
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

@RunWith(AndroidJUnit4::class)
// The real Application schedules WorkManager, which these tests don\'t need.
@Config(application = android.app.Application::class)
class ArticleLayerTest {
    @get:Rule val composeRule = createComposeRule()

    private val list = listOf("a", "b")
    private var open by mutableStateOf<EntryKey?>(null)
    private var closes = 0
    /** What the page on screen tells once it has drawn its article: the latest. */
    private var pageDrew: () -> Unit = {}

    private fun setContent() {
        composeRule.setContent {
            ArticleLayer(
                open = open,
                animate = false,
                onBack = {
                    closes++
                    open = null
                },
                list = { Text("The list") },
            ) { opened, _, onReady ->
                if (opened != null) {
                    Text("Article ${opened.id}")
                    SideEffect { pageDrew = { onReady(opened) } }
                }
            }
        }
    }

    private fun openArticle(id: String) {
        open = EntryKey.openedFrom(id, list)
        composeRule.waitForIdle()
    }

    private fun drawPage() {
        composeRule.runOnIdle { pageDrew() }
        composeRule.waitForIdle()
    }

    @Test
    fun anOpenedArticleWaitsBehindTheListUntilItsPageHasDrawnIt() {
        setContent()
        openArticle("a")
        // Composed, but hidden from accessibility services (and so from this) while it waits.
        composeRule.onNodeWithText("Article a").assertDoesNotExist()

        drawPage()

        composeRule.onNodeWithText("Article a").assertExists()
    }

    @Test
    fun reopeningTheSameArticleWaitsForItsPageAgain() {
        setContent()
        openArticle("a")
        drawPage()
        open = null
        composeRule.waitForIdle()

        openArticle("a")

        composeRule.onNodeWithText("Article a").assertDoesNotExist()
    }

    @Test
    fun backClosesTheArticleOnScreenOnly() {
        setContent()
        openArticle("a")
        drawPage()

        Espresso.pressBack()
        composeRule.waitForIdle()

        assertEquals(1, closes)
        composeRule.onNodeWithText("Article a").assertDoesNotExist()
        composeRule.onNodeWithText("The list").assertExists()
    }
}
