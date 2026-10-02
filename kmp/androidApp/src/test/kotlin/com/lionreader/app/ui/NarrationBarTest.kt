package com.lionreader.app.ui

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasStateDescription
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.lionreader.app.narration.NarrationState
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

@RunWith(AndroidJUnit4::class)
// The real Application schedules WorkManager, which these tests don\'t need.
@Config(application = android.app.Application::class)
class NarrationBarTest {
    @get:Rule val composeRule = createComposeRule()

    @Test
    fun waitingForAudioShowsASpinnerThatStillPauses() {
        val state = mutableStateOf(NarrationState("a", "Title", 0, playing = true, waiting = true))
        var toggles = 0
        composeRule.setContent {
            NarrationBar(state.value, 1f, {}, { toggles++ }, {}, {})
        }

        // A moment of waiting (any seek) doesn't show it.
        composeRule.onNode(hasStateDescription("Loading")).assertDoesNotExist()
        composeRule.mainClock.advanceTimeBy(400)
        composeRule.onNode(hasStateDescription("Loading")).assertIsDisplayed()
        composeRule.onNodeWithContentDescription("Pause").performClick()
        assertEquals(1, toggles)

        state.value = state.value.copy(waiting = false)
        composeRule.waitForIdle()
        composeRule.onNode(hasStateDescription("Loading")).assertDoesNotExist()
        composeRule.onNodeWithContentDescription("Pause").assertIsDisplayed()
    }

    @Test
    fun theSpeedButtonSaysWhatItIs() {
        var speed = 0f
        composeRule.setContent {
            NarrationBar(NarrationState("a", "Title", 0, playing = true), 1f, {}, {}, {}) {
                speed = it
            }
        }

        composeRule.onNodeWithContentDescription("Narration speed: 1×").performClick()
        assertEquals(1.25f, speed)
    }

    @Test
    fun pausedShowsPlayEvenWhileWaiting() {
        composeRule.setContent {
            NarrationBar(
                NarrationState("a", "Title", 0, playing = false, waiting = true),
                1f,
                {},
                {},
                {},
                {},
            )
        }
        composeRule.onNodeWithContentDescription("Play").assertIsDisplayed()
    }
}
