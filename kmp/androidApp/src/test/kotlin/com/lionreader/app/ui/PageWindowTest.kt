package com.lionreader.app.ui

import android.view.View
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.PagerState
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeLeft
import androidx.compose.ui.test.swipeRight
import androidx.compose.ui.unit.dp
import androidx.core.view.ViewCompat
import androidx.core.view.accessibility.AccessibilityNodeInfoCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.lionreader.app.EntryKey
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

@RunWith(AndroidJUnit4::class)
// The real Application schedules WorkManager, which these tests don\'t need.
@Config(application = android.app.Application::class)
class PageWindowTest {
    @get:Rule val composeRule = createComposeRule()

    private val list = listOf("a", "b", "c")

    @Test
    fun anArticleOpensOnThePageOnScreenWithItsListAroundIt() {
        val window = PageWindow.opening(EntryKey.openedFrom("b", list), at = 50)

        assertEquals("b", window.idAt(50))
        assertEquals("a", window.idAt(49))
        assertEquals("c", window.idAt(51))
        assertNull(window.idAt(48))
        // The pager ends with the list.
        assertEquals(52, window.pageCount)
    }

    @Test
    fun beforeAnyArticleThePageOnScreenAndItsNeighboursWait() {
        val window = PageWindow.opening(null, at = 50)

        assertNull(window.idAt(50))
        assertEquals(52, window.pageCount)
    }

    private lateinit var pager: PagerState
    private lateinit var view: View

    private fun showPager(window: PageWindow) {
        composeRule.setContent {
            view = LocalView.current
            pager = rememberPagerState(initialPage = PageWindow.START) { window.pageCount }
            HorizontalPager(
                state = pager,
                modifier = Modifier.size(300.dp).testTag("pager").stayInList(pager, window),
            ) { page ->
                Text(window.idAt(page) ?: "none", Modifier.fillMaxSize())
            }
        }
    }

    @Test
    fun swipesStopAtTheListsFirstArticle() {
        val window = PageWindow.opening(EntryKey.openedFrom("a", list), at = PageWindow.START)
        showPager(window)

        composeRule.onNodeWithTag("pager").performTouchInput { swipeRight() }
        composeRule.waitForIdle()
        assertEquals("a", window.idAt(pager.currentPage))

        composeRule.onNodeWithTag("pager").performTouchInput { swipeLeft() }
        composeRule.waitForIdle()
        assertEquals("b", window.idAt(pager.currentPage))
        composeRule.onNodeWithTag("pager").performTouchInput { swipeRight() }
        composeRule.waitForIdle()
        assertEquals("a", window.idAt(pager.currentPage))
    }

    /** As TalkBack does it: through the accessibility node of the pager. */
    private fun accessibilityAction(action: Int): Boolean {
        val provider =
            ViewCompat.getAccessibilityDelegate(view)!!.getAccessibilityNodeProvider(view)!!
        val id = composeRule.onNodeWithTag("pager").fetchSemanticsNode().id
        return composeRule
            .runOnIdle { provider.performAction(id, action, null) }
            .also { composeRule.waitForIdle() }
    }

    @Test
    fun talkBackPageTurnsStopAtTheListsFirstArticle() {
        val window = PageWindow.opening(EntryKey.openedFrom("b", list), at = PageWindow.START)
        showPager(window)

        assertTrue(accessibilityAction(AccessibilityNodeInfoCompat.ACTION_SCROLL_BACKWARD))
        assertEquals("a", window.idAt(pager.currentPage))

        assertFalse(accessibilityAction(AccessibilityNodeInfoCompat.ACTION_SCROLL_BACKWARD))
        assertFalse(accessibilityAction(android.R.id.accessibilityActionPageLeft))
        assertEquals("a", window.idAt(pager.currentPage))

        assertTrue(accessibilityAction(AccessibilityNodeInfoCompat.ACTION_SCROLL_FORWARD))
        assertEquals("b", window.idAt(pager.currentPage))
    }
}
