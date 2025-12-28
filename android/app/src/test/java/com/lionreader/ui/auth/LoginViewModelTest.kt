package com.lionreader.ui.auth

import app.cash.turbine.test
import com.lionreader.data.api.models.User
import com.lionreader.data.repository.AuthRepository
import com.lionreader.data.repository.AuthResult
import io.mockk.coEvery
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Unit tests for [LoginViewModel].
 *
 * Tests cover:
 * - Input validation (email format, required fields)
 * - Login success flow
 * - Login error handling
 * - UI state management
 */
@OptIn(ExperimentalCoroutinesApi::class)
class LoginViewModelTest {

    private val testDispatcher = StandardTestDispatcher()
    private lateinit var authRepository: AuthRepository
    private lateinit var viewModel: LoginViewModel

    @BeforeEach
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        authRepository = mockk()
        viewModel = LoginViewModel(authRepository)
    }

    @AfterEach
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Nested
    @DisplayName("Input Validation")
    inner class InputValidation {

        @Test
        @DisplayName("Empty email shows error")
        fun emptyEmailShowsError() = runTest {
            viewModel.onPasswordChange("password123")
            viewModel.login()

            val state = viewModel.uiState.value
            assertEquals("Email is required", state.error)
            assertFalse(state.isLoading)
        }

        @Test
        @DisplayName("Invalid email format shows error")
        fun invalidEmailShowsError() = runTest {
            viewModel.onEmailChange("invalid-email")
            viewModel.onPasswordChange("password123")
            viewModel.login()

            val state = viewModel.uiState.value
            assertEquals("Please enter a valid email address", state.error)
            assertFalse(state.isLoading)
        }

        @Test
        @DisplayName("Empty password shows error")
        fun emptyPasswordShowsError() = runTest {
            viewModel.onEmailChange("user@example.com")
            viewModel.login()

            val state = viewModel.uiState.value
            assertEquals("Password is required", state.error)
            assertFalse(state.isLoading)
        }

        @Test
        @DisplayName("Valid email formats are accepted")
        fun validEmailFormatsAccepted() = runTest {
            val validEmails = listOf(
                "user@example.com",
                "user.name@example.com",
                "user+tag@example.co.uk",
                "user123@test-domain.org"
            )

            coEvery { authRepository.login(any(), any()) } returns AuthResult.Success(
                User(id = "1", email = "user@example.com")
            )

            for (email in validEmails) {
                viewModel = LoginViewModel(authRepository)
                viewModel.onEmailChange(email)
                viewModel.onPasswordChange("password123")
                viewModel.login()
                testDispatcher.scheduler.advanceUntilIdle()

                val state = viewModel.uiState.value
                assertNull(state.error, "Email '$email' should be valid but got error: ${state.error}")
            }
        }
    }

    @Nested
    @DisplayName("Login Success")
    inner class LoginSuccess {

        @Test
        @DisplayName("Successful login emits LoginSuccess event")
        fun successfulLoginEmitsEvent() = runTest {
            coEvery { authRepository.login("user@example.com", "password123") } returns
                AuthResult.Success(User(id = "1", email = "user@example.com"))

            viewModel.onEmailChange("user@example.com")
            viewModel.onPasswordChange("password123")

            viewModel.events.test {
                viewModel.login()
                testDispatcher.scheduler.advanceUntilIdle()

                assertEquals(LoginEvent.LoginSuccess, awaitItem())
            }
        }

        @Test
        @DisplayName("Successful login clears loading state")
        fun successfulLoginClearsLoading() = runTest {
            coEvery { authRepository.login(any(), any()) } returns
                AuthResult.Success(User(id = "1", email = "user@example.com"))

            viewModel.onEmailChange("user@example.com")
            viewModel.onPasswordChange("password123")
            viewModel.login()
            testDispatcher.scheduler.advanceUntilIdle()

            val state = viewModel.uiState.value
            assertFalse(state.isLoading)
            assertNull(state.error)
        }
    }

    @Nested
    @DisplayName("Login Failure")
    inner class LoginFailure {

        @Test
        @DisplayName("Invalid credentials shows appropriate error")
        fun invalidCredentialsShowsError() = runTest {
            coEvery { authRepository.login(any(), any()) } returns
                AuthResult.Error("UNAUTHORIZED", "Invalid credentials")

            viewModel.onEmailChange("user@example.com")
            viewModel.onPasswordChange("wrongpassword")
            viewModel.login()
            testDispatcher.scheduler.advanceUntilIdle()

            val state = viewModel.uiState.value
            assertEquals("Invalid email or password", state.error)
            assertFalse(state.isLoading)
        }

        @Test
        @DisplayName("Rate limited error shows appropriate message")
        fun rateLimitedShowsError() = runTest {
            coEvery { authRepository.login(any(), any()) } returns
                AuthResult.Error("RATE_LIMITED", "Too many attempts")

            viewModel.onEmailChange("user@example.com")
            viewModel.onPasswordChange("password123")
            viewModel.login()
            testDispatcher.scheduler.advanceUntilIdle()

            val state = viewModel.uiState.value
            assertEquals("Too many attempts. Please try again later.", state.error)
        }

        @Test
        @DisplayName("Network error shows connectivity message")
        fun networkErrorShowsMessage() = runTest {
            coEvery { authRepository.login(any(), any()) } returns
                AuthResult.NetworkError

            viewModel.onEmailChange("user@example.com")
            viewModel.onPasswordChange("password123")
            viewModel.login()
            testDispatcher.scheduler.advanceUntilIdle()

            val state = viewModel.uiState.value
            assertEquals("Unable to connect. Please check your internet connection.", state.error)
        }

        @Test
        @DisplayName("User not found shows appropriate message")
        fun userNotFoundShowsError() = runTest {
            coEvery { authRepository.login(any(), any()) } returns
                AuthResult.Error("USER_NOT_FOUND", "No account found")

            viewModel.onEmailChange("nobody@example.com")
            viewModel.onPasswordChange("password123")
            viewModel.login()
            testDispatcher.scheduler.advanceUntilIdle()

            val state = viewModel.uiState.value
            assertEquals("No account found with this email", state.error)
        }
    }

    @Nested
    @DisplayName("UI State Management")
    inner class UiStateManagement {

        @Test
        @DisplayName("Email change updates state and clears error")
        fun emailChangeUpdatesState() = runTest {
            // Set an error first
            viewModel.login() // This will set "Email is required" error
            assertTrue(viewModel.uiState.value.error != null)

            // Change email should clear error
            viewModel.onEmailChange("test@example.com")

            val state = viewModel.uiState.value
            assertEquals("test@example.com", state.email)
            assertNull(state.error)
        }

        @Test
        @DisplayName("Password change updates state and clears error")
        fun passwordChangeUpdatesState() = runTest {
            viewModel.onEmailChange("test@example.com")
            viewModel.login() // This will set "Password is required" error
            assertTrue(viewModel.uiState.value.error != null)

            viewModel.onPasswordChange("secret123")

            val state = viewModel.uiState.value
            assertEquals("secret123", state.password)
            assertNull(state.error)
        }

        @Test
        @DisplayName("Toggle password visibility works correctly")
        fun togglePasswordVisibility() = runTest {
            assertFalse(viewModel.uiState.value.isPasswordVisible)

            viewModel.togglePasswordVisibility()
            assertTrue(viewModel.uiState.value.isPasswordVisible)

            viewModel.togglePasswordVisibility()
            assertFalse(viewModel.uiState.value.isPasswordVisible)
        }

        @Test
        @DisplayName("Clear error removes error message")
        fun clearErrorRemovesMessage() = runTest {
            viewModel.login() // Creates an error
            assertTrue(viewModel.uiState.value.error != null)

            viewModel.clearError()

            assertNull(viewModel.uiState.value.error)
        }

        @Test
        @DisplayName("Loading state is set during login attempt")
        fun loadingStateDuringLogin() = runTest {
            coEvery { authRepository.login(any(), any()) } coAnswers {
                kotlinx.coroutines.delay(100)
                AuthResult.Success(User(id = "1", email = "user@example.com"))
            }

            viewModel.onEmailChange("user@example.com")
            viewModel.onPasswordChange("password123")

            viewModel.uiState.test {
                assertEquals(LoginUiState(email = "user@example.com", password = "password123"), awaitItem())

                viewModel.login()

                // Should show loading state
                val loadingState = awaitItem()
                assertTrue(loadingState.isLoading)
                assertNull(loadingState.error)

                testDispatcher.scheduler.advanceUntilIdle()

                // Should clear loading state
                val doneState = awaitItem()
                assertFalse(doneState.isLoading)
            }
        }
    }
}
