package com.lionreader.app.ui

import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

@RunWith(AndroidJUnit4::class)
// The real Application schedules WorkManager, which these tests don\'t need.
@Config(application = android.app.Application::class)
class SignInScreenTest {
    @get:Rule val composeRule = createComposeRule()

    @Test
    fun aSignInErrorIsAnnounced() {
        composeRule.setContent {
            SignInScreen("https://lionreader.com", "Couldn't reach the server", false) {}
        }

        composeRule
            .onNode(
                hasText("Couldn't reach the server") and
                    SemanticsMatcher.expectValue(
                        SemanticsProperties.LiveRegion,
                        LiveRegionMode.Polite,
                    )
            )
            .assertIsDisplayed()
    }

    @Test
    fun theServerIsCheckedBeforeSigningIn() {
        val signIns = mutableListOf<String>()
        composeRule.setContent {
            SignInScreen("https://lionreader.com", null, false) { signIns += it }
        }
        composeRule.onNodeWithText("Server: https://lionreader.com").performClick()

        composeRule
            .onNodeWithText("https://lionreader.com")
            .performTextReplacement("http://reader.example")
        composeRule.onNodeWithText("Sign in").performClick()
        composeRule
            .onNodeWithText("Use an https:// address: signing in over http isn't safe.")
            .assertIsDisplayed()
        assertEquals(emptyList<String>(), signIns)

        composeRule
            .onNodeWithText("http://reader.example")
            .performTextReplacement("Reader.Example/")
        composeRule.onNodeWithText("Sign in").performClick()
        assertEquals(listOf("https://reader.example"), signIns)
    }
}
