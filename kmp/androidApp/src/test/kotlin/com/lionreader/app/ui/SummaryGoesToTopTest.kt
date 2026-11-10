package com.lionreader.app.ui

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.lionreader.app.reader.ReadingPosition
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

@RunWith(AndroidJUnit4::class)
// The real Application schedules WorkManager, which these tests don't need.
@Config(application = android.app.Application::class)
class SummaryGoesToTopTest {
    @get:Rule val composeRule = createComposeRule()

    private val position = ReadingPosition(0.5f)
    private val shown = mutableStateOf(false)

    private fun show(summaryShown: Boolean = false) {
        shown.value = summaryShown
        composeRule.setContent { SummaryGoesToTop("a", shown.value, position) }
        composeRule.waitForIdle()
    }

    private fun summary(on: Boolean) {
        shown.value = on
        composeRule.waitForIdle()
    }

    @Test
    fun turningTheSummaryOnGoesToTheTopAndOffStaysPut() {
        show()

        summary(on = true)
        assertEquals(0f, position.fraction)

        position.fraction = 0.3f
        summary(on = false)
        assertEquals(0.3f, position.fraction)

        summary(on = true)
        assertEquals(0f, position.fraction)
    }

    @Test
    fun aPageOpeningWithItsSummaryKeepsItsPlace() {
        show(summaryShown = true)

        assertEquals(0.5f, position.fraction)
    }
}
