package com.lionreader.ui.main

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.lionreader.ui.navigation.Screen
import kotlinx.coroutines.launch

/**
 * Main screen composable with navigation drawer.
 *
 * Contains the ModalNavigationDrawer with AppDrawer content and a Scaffold
 * with TopAppBar. Manages drawer open/close state and handles navigation
 * between different entry list views.
 *
 * @param onNavigateToEntry Callback when an entry is selected for detail view
 * @param mainViewModel ViewModel for main screen state
 * @param drawerViewModel ViewModel for drawer data
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MainScreen(
    onNavigateToEntry: (String) -> Unit,
    mainViewModel: MainViewModel = hiltViewModel(),
    drawerViewModel: DrawerViewModel = hiltViewModel(),
) {
    val uiState by mainViewModel.uiState.collectAsStateWithLifecycle()
    val subscriptions by drawerViewModel.subscriptions.collectAsStateWithLifecycle()
    val tags by drawerViewModel.tags.collectAsStateWithLifecycle()
    val totalUnreadCount by drawerViewModel.totalUnreadCount.collectAsStateWithLifecycle()

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
                onNavigate = { route ->
                    mainViewModel.navigateTo(route)
                    scope.launch {
                        drawerState.close()
                    }
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
    ) {
        Scaffold(
            topBar = {
                TopAppBar(
                    title = {
                        Text(text = uiState.title)
                    },
                    navigationIcon = {
                        IconButton(
                            onClick = {
                                scope.launch {
                                    drawerState.open()
                                }
                            },
                        ) {
                            Icon(
                                imageVector = Icons.Default.Menu,
                                contentDescription = "Open navigation drawer",
                            )
                        }
                    },
                    colors = TopAppBarDefaults.topAppBarColors(
                        containerColor = MaterialTheme.colorScheme.surface,
                        titleContentColor = MaterialTheme.colorScheme.onSurface,
                    ),
                )
            },
        ) { padding ->
            // Content area - will be replaced with EntryListScreen in future phase
            MainContent(
                currentRoute = uiState.currentRoute,
                isLoading = uiState.isLoading,
                onNavigateToEntry = onNavigateToEntry,
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding),
            )
        }
    }
}

/**
 * Main content area showing entry list based on current route.
 *
 * This is a placeholder that will be replaced with EntryListScreen
 * in a future phase. Currently shows the route being displayed.
 *
 * @param currentRoute Current navigation route
 * @param isLoading Whether content is loading
 * @param onNavigateToEntry Callback when an entry is clicked
 * @param modifier Modifier for the content
 */
@Composable
private fun MainContent(
    currentRoute: String,
    isLoading: Boolean,
    onNavigateToEntry: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier = modifier,
        contentAlignment = Alignment.Center,
    ) {
        val displayText = when {
            currentRoute == Screen.All.route -> "All Entries"
            currentRoute == Screen.Starred.route -> "Starred Entries"
            currentRoute.startsWith("tag/") -> {
                val tagId = currentRoute.removePrefix("tag/")
                "Tag: $tagId"
            }
            currentRoute.startsWith("feed/") -> {
                val feedId = currentRoute.removePrefix("feed/")
                "Feed: $feedId"
            }
            else -> "Entries"
        }

        Text(
            text = if (isLoading) "Loading..." else displayText,
            style = MaterialTheme.typography.headlineMedium,
            color = MaterialTheme.colorScheme.onSurface,
        )
    }
}
