package com.lionreader.ui.main

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.lionreader.data.db.entities.TagEntity
import com.lionreader.data.db.relations.SubscriptionWithFeed
import com.lionreader.data.repository.AuthRepository
import com.lionreader.data.repository.SubscriptionRepository
import com.lionreader.data.repository.TagRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * ViewModel for the navigation drawer.
 *
 * Provides subscriptions and tags data for drawer display, and handles
 * sign out functionality. Data is exposed as StateFlows for reactive
 * UI updates.
 */
@HiltViewModel
class DrawerViewModel @Inject constructor(
    private val subscriptionRepository: SubscriptionRepository,
    private val tagRepository: TagRepository,
    private val authRepository: AuthRepository,
) : ViewModel() {

    /**
     * All subscriptions with their feed information.
     *
     * Used to display feeds in the navigation drawer with unread counts.
     * Automatically updates when the underlying data changes.
     */
    val subscriptions: StateFlow<List<SubscriptionWithFeed>> =
        subscriptionRepository.getSubscriptions()
            .stateIn(
                scope = viewModelScope,
                started = SharingStarted.WhileSubscribed(5000),
                initialValue = emptyList(),
            )

    /**
     * All tags for grouping subscriptions.
     *
     * Used to display the tags section in the navigation drawer
     * with colored indicators and feed counts.
     */
    val tags: StateFlow<List<TagEntity>> =
        tagRepository.getTags()
            .stateIn(
                scope = viewModelScope,
                started = SharingStarted.WhileSubscribed(5000),
                initialValue = emptyList(),
            )

    /**
     * Total unread count across all subscriptions.
     *
     * Can be used to display badge on "All" navigation item.
     */
    val totalUnreadCount: StateFlow<Int> =
        subscriptionRepository.getTotalUnreadCount()
            .stateIn(
                scope = viewModelScope,
                started = SharingStarted.WhileSubscribed(5000),
                initialValue = 0,
            )

    /**
     * Signs out the current user.
     *
     * Clears the session and local data. The auth state change will
     * automatically trigger navigation to the login screen via the
     * NavGraph's LaunchedEffect observing isLoggedIn.
     */
    fun signOut() {
        viewModelScope.launch {
            // Logout clears the session, which triggers auth state change
            authRepository.logout()
            // Clear cached data for privacy
            subscriptionRepository.clearAll()
            tagRepository.clearAll()
        }
    }

    /**
     * Syncs subscriptions and tags from the server.
     *
     * Called when the drawer is opened to refresh data.
     */
    fun refreshData() {
        viewModelScope.launch {
            subscriptionRepository.syncSubscriptions()
            tagRepository.syncTags()
        }
    }
}
