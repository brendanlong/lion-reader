package com.lionreader.app.reader

import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

@RunWith(AndroidJUnit4::class)
// The real Application schedules WorkManager, which these tests don't need.
@Config(application = android.app.Application::class)
class ReadingPositionTest {
    @get:Rule val composeRule = createComposeRule()

    @Test
    fun thePlaceSurvivesTheActivityBeingRecreated() {
        val restoration = StateRestorationTester(composeRule)
        lateinit var position: ReadingPosition
        restoration.setContent {
            position = rememberSaveable(saver = ReadingPosition.Saver) { ReadingPosition() }
        }
        position.fraction = 0.4f
        restoration.emulateSavedInstanceStateRestore()
        composeRule.waitForIdle()

        assertEquals(0.4f, position.fraction)
    }
}
