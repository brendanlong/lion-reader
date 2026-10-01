package com.lionreader.app.ui

import androidx.compose.material3.DrawerState
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.Text
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeRight
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

@RunWith(AndroidJUnit4::class)
// The real Application schedules WorkManager, which these tests don't need.
@Config(application = android.app.Application::class)
class SettlePromptlyTest {
    @get:Rule val composeRule = createComposeRule()

    private lateinit var drawer: DrawerState
    private lateinit var scope: CoroutineScope

    private fun show() {
        composeRule.setContent {
            drawer = rememberDrawerState(DrawerValue.Closed)
            scope = rememberCoroutineScope()
            ModalNavigationDrawer(
                drawerState = drawer,
                drawerContent = {
                    ModalDrawerSheet(drawerState = drawer, modifier = settlePromptly(drawer)) {
                        Text("Lists")
                    }
                },
            ) {
                Text("Content")
            }
        }
        composeRule.mainClock.autoAdvance = false
    }

    // While it animates, the drawer takes a tap as a drag; it mustn't linger
    // after it looks done (the default spring was still going at 500ms).
    @Test
    fun theDrawerStopsAnimatingOnceItLooksOpen() {
        show()
        scope.launch { drawer.open() }
        composeRule.mainClock.advanceTimeBy(350)

        assertEquals(DrawerValue.Open, drawer.currentValue)
        assertFalse(drawer.isAnimationRunning)
    }

    @Test
    fun andOnceItLooksClosed() {
        show()
        scope.launch { drawer.snapTo(DrawerValue.Open) }
        composeRule.mainClock.advanceTimeBy(50)
        scope.launch { drawer.close() }
        composeRule.mainClock.advanceTimeBy(350)

        assertEquals(DrawerValue.Closed, drawer.currentValue)
        assertFalse(drawer.isAnimationRunning)
    }

    @Test
    fun closingAfterOpeningByHandStillAnimates() {
        show()
        composeRule.mainClock.autoAdvance = true
        composeRule.onRoot().performTouchInput { swipeRight(startX = 1f, endX = right * 0.9f) }
        composeRule.waitForIdle()
        assertEquals(DrawerValue.Open, drawer.currentValue)

        composeRule.mainClock.autoAdvance = false
        scope.launch { drawer.close() }
        composeRule.mainClock.advanceTimeBy(100)
        assertTrue(drawer.isAnimationRunning)
        assertTrue(drawer.currentOffset < 0f)
        composeRule.mainClock.advanceTimeBy(400)
        assertEquals(DrawerValue.Closed, drawer.currentValue)
    }
}
