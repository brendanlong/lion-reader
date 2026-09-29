package com.lionreader.app

import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PlaceholderScreenTest {
    @get:Rule val composeRule = createComposeRule()

    @Test
    fun showsGreetingFromShared() {
        composeRule.setContent { PlaceholderScreen() }
        composeRule.onNodeWithText("Lion Reader on Android").assertExists()
    }
}
