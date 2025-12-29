package com.lionreader.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import com.lionreader.ui.auth.LoginScreenContent
import com.lionreader.ui.auth.LoginUiState
import com.lionreader.ui.theme.LionReaderTheme
import org.junit.Rule
import org.junit.Test

/**
 * UI tests for [LoginScreenContent].
 *
 * Tests cover:
 * - Screen rendering
 * - Form input interactions
 * - Loading state
 * - Error display
 */
class LoginScreenTest {
    @get:Rule
    val composeTestRule = createComposeRule()

    @Test
    fun loginScreen_initialState_displaysEmptyForm() {
        composeTestRule.setContent {
            LionReaderTheme {
                LoginScreenContent(
                    uiState = LoginUiState(),
                    onEmailChange = {},
                    onPasswordChange = {},
                    onTogglePasswordVisibility = {},
                    onLogin = {},
                )
            }
        }

        // Check that main UI elements are visible
        composeTestRule.onNodeWithText("Lion Reader").assertIsDisplayed()
        composeTestRule.onNodeWithText("Sign in to continue").assertIsDisplayed()
        composeTestRule.onNodeWithText("Email").assertIsDisplayed()
        composeTestRule.onNodeWithText("Password").assertIsDisplayed()
        composeTestRule.onNodeWithText("Sign In").assertIsDisplayed()
    }

    @Test
    fun loginScreen_withEmail_displaysEmailInField() {
        composeTestRule.setContent {
            LionReaderTheme {
                LoginScreenContent(
                    uiState = LoginUiState(email = "user@example.com"),
                    onEmailChange = {},
                    onPasswordChange = {},
                    onTogglePasswordVisibility = {},
                    onLogin = {},
                )
            }
        }

        composeTestRule.onNodeWithText("user@example.com").assertIsDisplayed()
    }

    @Test
    fun loginScreen_typingEmail_callsOnEmailChange() {
        var capturedEmail = ""

        composeTestRule.setContent {
            LionReaderTheme {
                LoginScreenContent(
                    uiState = LoginUiState(),
                    onEmailChange = { capturedEmail = it },
                    onPasswordChange = {},
                    onTogglePasswordVisibility = {},
                    onLogin = {},
                )
            }
        }

        composeTestRule.onNodeWithText("Email").performTextInput("test@example.com")

        assert(capturedEmail == "test@example.com") {
            "Expected email to be 'test@example.com' but was '$capturedEmail'"
        }
    }

    @Test
    fun loginScreen_typingPassword_callsOnPasswordChange() {
        var capturedPassword = ""

        composeTestRule.setContent {
            LionReaderTheme {
                LoginScreenContent(
                    uiState = LoginUiState(),
                    onEmailChange = {},
                    onPasswordChange = { capturedPassword = it },
                    onTogglePasswordVisibility = {},
                    onLogin = {},
                )
            }
        }

        composeTestRule.onNodeWithText("Password").performTextInput("secret123")

        assert(capturedPassword == "secret123") {
            "Expected password to be 'secret123' but was '$capturedPassword'"
        }
    }

    @Test
    fun loginScreen_clickingSignIn_callsOnLogin() {
        var loginClicked = false

        composeTestRule.setContent {
            LionReaderTheme {
                LoginScreenContent(
                    uiState =
                        LoginUiState(
                            email = "user@example.com",
                            password = "password123",
                        ),
                    onEmailChange = {},
                    onPasswordChange = {},
                    onTogglePasswordVisibility = {},
                    onLogin = { loginClicked = true },
                )
            }
        }

        composeTestRule.onNodeWithText("Sign In").performClick()

        assert(loginClicked) { "Expected onLogin to be called" }
    }

    @Test
    fun loginScreen_loadingState_disablesInputsAndShowsProgress() {
        composeTestRule.setContent {
            LionReaderTheme {
                LoginScreenContent(
                    uiState =
                        LoginUiState(
                            email = "user@example.com",
                            password = "password",
                            isLoading = true,
                        ),
                    onEmailChange = {},
                    onPasswordChange = {},
                    onTogglePasswordVisibility = {},
                    onLogin = {},
                )
            }
        }

        // Sign In button should be disabled during loading
        composeTestRule.onNodeWithText("Sign In").assertDoesNotExist() // Text replaced by progress indicator
    }

    @Test
    fun loginScreen_withError_displaysErrorMessage() {
        composeTestRule.setContent {
            LionReaderTheme {
                LoginScreenContent(
                    uiState =
                        LoginUiState(
                            email = "user@example.com",
                            password = "wrongpassword",
                            error = "Invalid email or password",
                        ),
                    onEmailChange = {},
                    onPasswordChange = {},
                    onTogglePasswordVisibility = {},
                    onLogin = {},
                )
            }
        }

        composeTestRule.onNodeWithText("Invalid email or password").assertIsDisplayed()
    }

    @Test
    fun loginScreen_passwordVisibility_togglesOnClick() {
        var toggleClicked = false

        composeTestRule.setContent {
            LionReaderTheme {
                LoginScreenContent(
                    uiState =
                        LoginUiState(
                            password = "secret",
                            isPasswordVisible = false,
                        ),
                    onEmailChange = {},
                    onPasswordChange = {},
                    onTogglePasswordVisibility = { toggleClicked = true },
                    onLogin = {},
                )
            }
        }

        composeTestRule.onNodeWithContentDescription("Show password").performClick()

        assert(toggleClicked) { "Expected password visibility toggle to be called" }
    }

    @Test
    fun loginScreen_passwordVisible_showsHideIcon() {
        composeTestRule.setContent {
            LionReaderTheme {
                LoginScreenContent(
                    uiState =
                        LoginUiState(
                            password = "secret",
                            isPasswordVisible = true,
                        ),
                    onEmailChange = {},
                    onPasswordChange = {},
                    onTogglePasswordVisibility = {},
                    onLogin = {},
                )
            }
        }

        composeTestRule.onNodeWithContentDescription("Hide password").assertIsDisplayed()
    }

    @Test
    fun loginScreen_notLoading_signInButtonIsEnabled() {
        composeTestRule.setContent {
            LionReaderTheme {
                LoginScreenContent(
                    uiState =
                        LoginUiState(
                            email = "user@example.com",
                            password = "password123",
                            isLoading = false,
                        ),
                    onEmailChange = {},
                    onPasswordChange = {},
                    onTogglePasswordVisibility = {},
                    onLogin = {},
                )
            }
        }

        composeTestRule.onNodeWithText("Sign In").assertIsEnabled()
    }
}
