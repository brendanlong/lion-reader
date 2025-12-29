package com.lionreader.ui.main

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.lionreader.data.repository.SubscriptionRepository
import com.lionreader.data.repository.TagRepository
import com.lionreader.ui.navigation.Screen
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * UI state for the main screen.
 *
 * @param currentRoute Current navigation route being displayed
 * @param title Title to display in the top app bar
 * @param isLoading Whether content is currently loading
 */
data class MainUiState(
    val currentRoute: String = Screen.All.route,
    val title: String = Screen.All.TITLE,
    val isLoading: Boolean = false,
)

/**
 * ViewModel for the main screen.
 *
 * Manages navigation state within the main screen content area,
 * including current route and screen title. The drawer state is
 * managed directly in the composable.
 */
@HiltViewModel
class MainViewModel
    @Inject
    constructor(
        private val savedStateHandle: SavedStateHandle,
        private val subscriptionRepository: SubscriptionRepository,
        private val tagRepository: TagRepository,
    ) : ViewModel() {
        private val _uiState = MutableStateFlow(MainUiState())
        val uiState: StateFlow<MainUiState> = _uiState.asStateFlow()

        init {
            // Restore route from saved state if available
            savedStateHandle.get<String>(KEY_CURRENT_ROUTE)?.let { route ->
                navigateTo(route)
            }
        }

        /**
         * Navigates to a new route within the main content area.
         *
         * Updates the current route and title based on the destination.
         *
         * @param route The route to navigate to
         */
        fun navigateTo(route: String) {
            viewModelScope.launch {
                val title = getRouteTitle(route)
                _uiState.value =
                    _uiState.value.copy(
                        currentRoute = route,
                        title = title,
                    )
                savedStateHandle[KEY_CURRENT_ROUTE] = route
            }
        }

        /**
         * Gets the title for a given route.
         *
         * For dynamic routes (tag/feed), fetches the name from the repository.
         */
        private suspend fun getRouteTitle(route: String): String =
            when {
                route == Screen.All.route -> Screen.All.TITLE
                route == Screen.Starred.route -> Screen.Starred.TITLE
                route.startsWith("tag/") -> {
                    val tagId = route.removePrefix("tag/")
                    tagRepository.getTag(tagId)?.name ?: "Tag"
                }
                route.startsWith("feed/") -> {
                    val feedId = route.removePrefix("feed/")
                    subscriptionRepository
                        .getSubscriptions()
                        .first()
                        .find { it.subscription.feedId == feedId }
                        ?.displayTitle ?: "Feed"
                }
                else -> "Lion Reader"
            }

        /**
         * Refreshes data from the server.
         *
         * Called on pull-to-refresh or when entering the main screen.
         */
        fun refresh() {
            viewModelScope.launch {
                _uiState.value = _uiState.value.copy(isLoading = true)
                try {
                    subscriptionRepository.syncSubscriptions()
                    tagRepository.syncTags()
                } finally {
                    _uiState.value = _uiState.value.copy(isLoading = false)
                }
            }
        }

        companion object {
            private const val KEY_CURRENT_ROUTE = "current_route"
        }
    }
