package com.lionreader.app.ui

import androidx.activity.compose.BackHandler
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
    private var listBacks = 0
    private var searching by mutableStateOf(false)
    /** What the page on screen tells once it has drawn its article: the latest. */
    private var pageDrew: () -> Unit = {}
    /** The article the layer was last given to show. */
    private var given: EntryKey? = null

    private fun setContent() {
        composeRule.setContent {
            ArticleLayer(
                open = open,
                animate = false,
                onBack = {
                    closes++
                    open = null
                },
                list = {
                    // Like the list's search, which Back closes.
                    BackHandler(enabled = searching) { listBacks++ }
                    Text("The list")
                },
            ) { opened, _, emptied, onReady ->
                SideEffect { given = opened.takeUnless { emptied } }
                if (opened != null && !emptied) {
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
        searching = true
        composeRule.waitForIdle()
        openArticle("a")
        drawPage()

        Espresso.pressBack()
        composeRule.waitForIdle()

        assertEquals(1, closes)
        assertEquals(0, listBacks)
        // Nothing left in it to play, or to show by mistake.
        composeRule.runOnIdle { assertEquals(null, given) }
        composeRule.onNodeWithText("Article a").assertDoesNotExist()
        composeRule.onNodeWithText("The list").assertExists()
    }

    @Test
    fun aNewLayerShowsTheArticleAlreadyOpen() {
        // As after rotation: its pages are new, so there's no last article to flash.
        open = EntryKey.openedFrom("a", list)
        setContent()

        composeRule.onNodeWithText("Article a").assertExists()
    }
}
