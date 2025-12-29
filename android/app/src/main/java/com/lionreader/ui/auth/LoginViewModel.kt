package com.lionreader.ui.auth

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.lionreader.data.repository.AuthRepository
import com.lionreader.data.repository.AuthResult
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * UI state for the login screen.
 *
 * @property email Current email input value
 * @property password Current password input value
 * @property isLoading Whether a login operation is in progress
 * @property error Error message to display, null if no error
 * @property isPasswordVisible Whether the password is visible
 */
data class LoginUiState(
    val email: String = "",
    val password: String = "",
    val isLoading: Boolean = false,
    val error: String? = null,
    val isPasswordVisible: Boolean = false,
)

/**
 * One-time events emitted by the ViewModel.
 */
sealed class LoginEvent {
    /**
     * Emitted when login succeeds and navigation should occur.
     */
    data object LoginSuccess : LoginEvent()
}

/**
 * ViewModel for the login screen.
 *
 * Manages the login form state, validates input, and coordinates
 * authentication with the AuthRepository.
 */
@HiltViewModel
class LoginViewModel
    @Inject
    constructor(
        private val authRepository: AuthRepository,
    ) : ViewModel() {
        private val _uiState = MutableStateFlow(LoginUiState())

        /**
         * Observable UI state for the login screen.
         */
        val uiState: StateFlow<LoginUiState> = _uiState.asStateFlow()

        private val _events = MutableSharedFlow<LoginEvent>()

        /**
         * One-time events for navigation and other side effects.
         */
        val events: SharedFlow<LoginEvent> = _events.asSharedFlow()

        /**
         * Updates the email field value and clears any existing error.
         *
         * @param email The new email value
         */
        fun onEmailChange(email: String) {
            _uiState.update {
                it.copy(email = email, error = null)
            }
        }

        /**
         * Updates the password field value and clears any existing error.
         *
         * @param password The new password value
         */
        fun onPasswordChange(password: String) {
            _uiState.update {
                it.copy(password = password, error = null)
            }
        }

        /**
         * Toggles password visibility.
         */
        fun togglePasswordVisibility() {
            _uiState.update {
                it.copy(isPasswordVisible = !it.isPasswordVisible)
            }
        }

        /**
         * Clears any displayed error message.
         */
        fun clearError() {
            _uiState.update {
                it.copy(error = null)
            }
        }

        /**
         * Attempts to log in with the current email and password.
         *
         * Validates input before making the API call. On success, emits
         * a LoginSuccess event. On failure, updates the error state.
         */
        fun login() {
            val state = _uiState.value

            // Validate email
            if (state.email.isBlank()) {
                _uiState.update { it.copy(error = "Email is required") }
                return
            }

            if (!isValidEmail(state.email)) {
                _uiState.update { it.copy(error = "Please enter a valid email address") }
                return
            }

            // Validate password
            if (state.password.isBlank()) {
                _uiState.update { it.copy(error = "Password is required") }
                return
            }

            // Perform login
            viewModelScope.launch {
                _uiState.update { it.copy(isLoading = true, error = null) }

                when (val result = authRepository.login(state.email, state.password)) {
                    is AuthResult.Success -> {
                        _uiState.update { it.copy(isLoading = false) }
                        _events.emit(LoginEvent.LoginSuccess)
                    }
                    is AuthResult.Error -> {
                        _uiState.update {
                            it.copy(
                                isLoading = false,
                                error = mapErrorMessage(result.code, result.message),
                            )
                        }
                    }
                    is AuthResult.NetworkError -> {
                        _uiState.update {
                            it.copy(
                                isLoading = false,
                                error = "Unable to connect. Please check your internet connection.",
                            )
                        }
                    }
                }
            }
        }

        /**
         * Validates email format using a simple regex pattern.
         */
        private fun isValidEmail(email: String): Boolean {
            val emailRegex = Regex("^[A-Za-z0-9+_.-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$")
            return emailRegex.matches(email)
        }

        /**
         * Maps error codes to user-friendly messages.
         */
        private fun mapErrorMessage(
            code: String,
            defaultMessage: String,
        ): String =
            when (code) {
                "UNAUTHORIZED" -> "Invalid email or password"
                "INVALID_CREDENTIALS" -> "Invalid email or password"
                "RATE_LIMITED" -> "Too many attempts. Please try again later."
                "USER_NOT_FOUND" -> "No account found with this email"
                else -> defaultMessage.ifBlank { "An error occurred. Please try again." }
            }
    }
