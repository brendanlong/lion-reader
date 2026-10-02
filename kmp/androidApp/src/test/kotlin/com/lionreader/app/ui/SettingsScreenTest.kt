package com.lionreader.app.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

@RunWith(AndroidJUnit4::class)
// The real Application schedules WorkManager, which these tests don\'t need.
@Config(application = android.app.Application::class)
class SettingsScreenTest {
    @get:Rule val composeRule = createComposeRule()

    /** Label and switch are one control: one node to focus, toggled from anywhere on the row. */
    @Test
    fun aSettingSwitchIsOneControl() {
        composeRule.setContent {
            var on by remember { mutableStateOf(false) }
            SettingSwitch("Animations", on, note = "A note") { on = it }
        }
        val switches = SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Switch)

        composeRule.onAllNodes(switches).assertCountEquals(1)
        val row = composeRule.onNode(switches and hasText("Animations") and hasText("A note"))
        row.assertIsOff()
        composeRule.onNodeWithText("Animations").performClick()
        row.assertIsOn()
    }

    @Test
    fun signingOutWithEverythingSentDoesntAsk() {
        var signedOut = 0
        composeRule.setContent { SignOutButton({ 0L }, { signedOut++ }) }

        composeRule.onNodeWithText("Sign out").performClick()

        composeRule.waitForIdle()
        assertEquals(1, signedOut)
        composeRule.onNodeWithText("Sign out?").assertDoesNotExist()
    }

    @Test
    fun unsentChangesAreConfirmedBeforeTheyreLost() {
        var signedOut = 0
        composeRule.setContent { SignOutButton({ 3L }, { signedOut++ }) }

        composeRule.onNodeWithText("Sign out").performClick()

        composeRule.onNodeWithText("3 changes haven't been sent and will be lost.").assertExists()
        assertEquals(0, signedOut)
        composeRule.onNodeWithText("Cancel").performClick()
        composeRule.onNodeWithText("Sign out?").assertDoesNotExist()
        assertEquals(0, signedOut)

        composeRule.onNodeWithText("Sign out").performClick()
        composeRule.onNodeWithText("Sign out?").assertExists()
        // The dialog's button, not the screen's.
        composeRule.onNode(hasText("Sign out") and hasAnyAncestor(isDialog())).performClick()
        assertEquals(1, signedOut)
    }
}
