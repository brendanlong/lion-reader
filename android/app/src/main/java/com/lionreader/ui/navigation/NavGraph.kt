package com.lionreader.ui.navigation

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.lionreader.data.repository.AuthRepository
import com.lionreader.ui.auth.LoginScreen

/**
 * Main navigation graph for the app.
 *
 * Handles routing between all screens and manages authentication state.
 * Automatically redirects to login when not authenticated and to main
 * screen when authenticated.
 *
 * @param authRepository Repository for checking authentication state
 * @param navController Navigation controller, uses remembered one by default
 * @param onUnauthorized Callback when 401 is received (placeholder for now)
 */
@Composable
fun LionReaderNavGraph(
    authRepository: AuthRepository,
    navController: NavHostController = rememberNavController(),
    onUnauthorized: () -> Unit = {},
) {
    val isLoggedIn by authRepository.isLoggedIn.collectAsStateWithLifecycle()

    // Determine start destination based on auth state
    val startDestination = if (isLoggedIn) Screen.Main.route else Screen.Login.route

    // Handle auth state changes for navigation
    LaunchedEffect(isLoggedIn) {
        val currentRoute = navController.currentDestination?.route

        when {
            // User logged in but on login screen -> navigate to main
            isLoggedIn && currentRoute == Screen.Login.route -> {
                navController.navigate(Screen.Main.route) {
                    popUpTo(Screen.Login.route) { inclusive = true }
                }
            }
            // User logged out but not on login screen -> navigate to login
            !isLoggedIn && currentRoute != Screen.Login.route -> {
                navController.navigate(Screen.Login.route) {
                    popUpTo(0) { inclusive = true }
                }
            }
        }
    }

    NavHost(
        navController = navController,
        startDestination = startDestination,
    ) {
        // Login screen
        composable(route = Screen.Login.route) {
            LoginScreen(
                onLoginSuccess = {
                    navController.navigate(Screen.Main.route) {
                        popUpTo(Screen.Login.route) { inclusive = true }
                    }
                },
            )
        }

        // Main screen (entry list) - placeholder for now
        composable(route = Screen.Main.route) {
            MainScreenPlaceholder()
        }

        // Entry detail screen - placeholder for now
        composable(route = Screen.EntryDetail.route) { backStackEntry ->
            val entryId = backStackEntry.arguments?.getString(Screen.ARG_ENTRY_ID) ?: ""
            EntryDetailPlaceholder(entryId = entryId)
        }
    }
}

/**
 * Placeholder for the main screen.
 *
 * Will be replaced with EntryListScreen in a future phase.
 */
@Composable
private fun MainScreenPlaceholder() {
    Scaffold { padding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = "Welcome to Lion Reader!",
                style = MaterialTheme.typography.headlineMedium,
            )
        }
    }
}

/**
 * Placeholder for the entry detail screen.
 *
 * Will be replaced with EntryDetailScreen in a future phase.
 */
@Composable
private fun EntryDetailPlaceholder(entryId: String) {
    Scaffold { padding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = "Entry Detail: $entryId",
                style = MaterialTheme.typography.headlineMedium,
            )
        }
    }
}

/**
 * Handles 401 Unauthorized responses.
 *
 * This is a placeholder that will be expanded in a future phase
 * to properly handle session expiration and token refresh.
 *
 * @param authRepository Repository to clear session
 * @param navController Navigation controller to redirect to login
 */
suspend fun handleUnauthorized(
    authRepository: AuthRepository,
    navController: NavHostController,
) {
    // Clear the session (this will trigger navigation via isLoggedIn flow)
    authRepository.logout()

    // Navigation will happen automatically via the LaunchedEffect
    // observing isLoggedIn state in LionReaderNavGraph
}
