package com.lionreader.app.ui

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.PagerState
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeLeft
import androidx.compose.ui.test.swipeRight
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.lionreader.app.EntryKey
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
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
        assertNull(window.inList(49))
    }

    @Test
    fun aPageOutsideTheListComesBackToItsNearestEnd() {
        val window = PageWindow.opening(EntryKey.openedFrom("a", list), at = 50)

        assertEquals(50, window.inList(47))
        assertNull(window.inList(51))
    }

    @Test
    fun swipesStopAtTheListsFirstArticle() {
        lateinit var pager: PagerState
        val window = PageWindow.opening(EntryKey.openedFrom("a", list), at = PageWindow.START)
        composeRule.setContent {
            pager = rememberPagerState(initialPage = PageWindow.START) { window.pageCount }
            HorizontalPager(
                state = pager,
                modifier =
                    Modifier.size(300.dp)
                        .testTag("pager")
                        .nestedScroll(rememberStayInList(pager, window)),
            ) { page ->
                Text(window.idAt(page) ?: "none", Modifier.fillMaxSize())
            }
        }

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
}
