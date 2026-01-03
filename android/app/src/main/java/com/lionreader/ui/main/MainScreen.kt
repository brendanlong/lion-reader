package com.lionreader.ui.main

import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.lionreader.ui.entries.EntryListScreen
import kotlinx.coroutines.launch

/**
 * Main screen composable with navigation drawer.
 *
 * Contains the ModalNavigationDrawer with AppDrawer content and the
 * EntryListScreen. Manages drawer open/close state and handles navigation
 * between different entry list views.
 *
 * @param onNavigateToEntry Callback when an entry is selected for detail view.
 *                          Parameters: (entryId, listContext) where listContext is the current route
 *                          for swipe navigation support.
 * @param onNavigateToSaved Callback when Saved Articles is selected from drawer
 * @param mainViewModel ViewModel for main screen state
 * @param drawerViewModel ViewModel for drawer data
 * @param modifier Modifier for the screen
 */
@Composable
fun MainScreen(
    onNavigateToEntry: (entryId: String, listContext: String) -> Unit,
    onNavigateToSaved: () -> Unit,
    mainViewModel: MainViewModel = hiltViewModel(),
    drawerViewModel: DrawerViewModel = hiltViewModel(),
    modifier: Modifier = Modifier,
) {
    val uiState by mainViewModel.uiState.collectAsStateWithLifecycle()
    val subscriptions by drawerViewModel.subscriptions.collectAsStateWithLifecycle()
    val tags by drawerViewModel.tags.collectAsStateWithLifecycle()
    val totalUnreadCount by drawerViewModel.totalUnreadCount.collectAsStateWithLifecycle()
    val starredUnreadCount by drawerViewModel.starredUnreadCount.collectAsStateWithLifecycle()
    val savedUnreadCount by drawerViewModel.savedUnreadCount.collectAsStateWithLifecycle()
    val uncategorizedUnreadCount by drawerViewModel.uncategorizedUnreadCount.collectAsStateWithLifecycle()

    val drawerState = rememberDrawerState(initialValue = DrawerValue.Closed)
    val scope = rememberCoroutineScope()

    // Refresh data when drawer is opened
    LaunchedEffect(drawerState.isOpen) {
        if (drawerState.isOpen) {
            drawerViewModel.refreshData()
        }
    }

    // Refresh data on first launch
    LaunchedEffect(Unit) {
        mainViewModel.refresh()
    }

    ModalNavigationDrawer(
        drawerState = drawerState,
        drawerContent = {
            AppDrawer(
                subscriptions = subscriptions,
                tags = tags,
                currentRoute = uiState.currentRoute,
                totalUnreadCount = totalUnreadCount,
                starredUnreadCount = starredUnreadCount,
                savedUnreadCount = savedUnreadCount,
                uncategorizedUnreadCount = uncategorizedUnreadCount,
                onNavigate = { route ->
                    mainViewModel.navigateTo(route)
                    scope.launch {
                        drawerState.close()
                    }
                },
                onNavigateToSaved = {
                    scope.launch {
                        drawerState.close()
                    }
                    onNavigateToSaved()
                },
                onSignOut = {
                    drawerViewModel.signOut()
                    scope.launch {
                        drawerState.close()
                    }
                },
            )
        },
        gesturesEnabled = true,
        modifier = modifier,
    ) {
        EntryListScreen(
            currentRoute = uiState.currentRoute,
            onEntryClick = { entryId -> onNavigateToEntry(entryId, uiState.currentRoute) },
            onDrawerOpen = {
                scope.launch {
                    drawerState.open()
                }
            },
        )
    }
}
