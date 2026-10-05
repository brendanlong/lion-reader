package com.lionreader.app.reader

import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

@RunWith(AndroidJUnit4::class)
// The real Application schedules WorkManager, which these tests don't need.
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

    @Test
    fun aPositionReportThatIsntTwoFiniteNumbersIsNoPlace() {
        assertEquals(
            ReadingAnchor(3, 0.5),
            parseAnchor(JSONObject("""{"element":3,"offset":0.5}""")),
        )
        for (at in
            listOf(
                """{"element":-1,"offset":0.5}""",
                """{"element":3,"offset":"NaN"}""",
                """{"element":3,"offset":"1e999"}""",
                """{"offset":0.5}""",
            )) {
            assertNull(at, parseAnchor(JSONObject(at)))
        }
        assertNull(parseAnchor(null))
    }
}
