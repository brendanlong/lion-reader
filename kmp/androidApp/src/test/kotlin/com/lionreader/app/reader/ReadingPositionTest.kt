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
// The real Application schedules WorkManager, which these tests don\'t need.
@Config(application = android.app.Application::class)
class ReadingPositionTest {
    @get:Rule val composeRule = createComposeRule()

    private fun restored(anchor: ReadingAnchor?): ReadingAnchor? {
        val restoration = StateRestorationTester(composeRule)
        lateinit var position: ReadingPosition
        restoration.setContent {
            position = rememberSaveable(saver = ReadingPosition.Saver) { ReadingPosition() }
        }
        position.anchor = anchor
        restoration.emulateSavedInstanceStateRestore()
        composeRule.waitForIdle()
        return position.anchor
    }

    @Test
    fun thePlaceSurvivesTheActivityBeingRecreated() {
        assertEquals(ReadingAnchor(42, -0.25), restored(ReadingAnchor(42, -0.25)))
    }
}
