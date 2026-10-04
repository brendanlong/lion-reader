package com.lionreader.app.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

@RunWith(AndroidJUnit4::class)
// The real Application schedules WorkManager, which these tests don't need.
@Config(application = android.app.Application::class)
class ScrollbarTest {
    @get:Rule val composeRule = createComposeRule()

    @Test
    fun theThumbIsTheViewportsShareOfTheTrackAndMovesWithTheOffset() {
        assertEquals(ThumbSpan(0f, 250f), thumbSpan(0, 4000, 1000, 1000f, 10f))
        assertEquals(ThumbSpan(375f, 250f), thumbSpan(1500, 4000, 1000, 1000f, 10f))
        assertEquals(ThumbSpan(750f, 250f), thumbSpan(3000, 4000, 1000, 1000f, 10f))
    }

    @Test
    fun aShortThumbIsLengthenedAndStillReachesTheBottom() {
        assertEquals(ThumbSpan(0f, 40f), thumbSpan(0, 100_000, 1000, 1000f, 40f))
        assertEquals(ThumbSpan(960f, 40f), thumbSpan(99_000, 100_000, 1000, 1000f, 40f))
    }

    @Test
    fun noThumbWhenNothingScrolls() {
        assertNull(thumbSpan(0, 1000, 1000, 1000f, 10f))
        assertNull(thumbSpan(0, 0, 0, 0f, 10f))
    }

    private lateinit var list: LazyListState

    /** [loaded] rows of 10px in a 100px window, from a list of [total]. */
    private fun showList(loaded: Int, total: Long): LongListIndicator {
        composeRule.setContent {
            CompositionLocalProvider(LocalDensity provides Density(1f)) {
                list = rememberLazyListState()
                LazyColumn(state = list, modifier = Modifier.height(100.dp)) {
                    items(loaded) { Box(Modifier.height(10.dp)) }
                }
            }
        }
        return LongListIndicator(list) { total }
    }

    @Test
    fun aListIsAsLongAsItsTotalNotItsLoadedRows() {
        val indicator = showList(loaded = 200, total = 1000)
        composeRule.runOnIdle { runBlocking { list.scrollToItem(50) } }
        composeRule.runOnIdle {
            assertEquals(10_000, indicator.contentSize)
            assertEquals(100, indicator.viewportSize)
            assertEquals(500, indicator.scrollOffset)
        }
    }
}
