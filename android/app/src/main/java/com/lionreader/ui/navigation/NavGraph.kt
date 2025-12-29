package com.lionreader.ui.navigation

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.lionreader.data.repository.AuthRepository
import com.lionreader.ui.auth.LoginScreen
import com.lionreader.ui.entries.EntryDetailScreen
import com.lionreader.ui.main.MainScreen

/**
 * Main navigation graph for the app.
 *
 * Handles routing between all screens and manages authentication state.
 * Automatically redirects to login when not authenticated and to main
 * screen when authenticated.
 *
 * Navigation structure:
 * - Login: Entry point for unauthenticated users
 * - Main: Container with navigation drawer, hosts entry list views
 * - EntryDetail: Full article view with back navigation
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

        // Main screen with navigation drawer
        composable(route = Screen.Main.route) {
            MainScreen(
                onNavigateToEntry = { entryId ->
                    navController.navigate(Screen.EntryDetail.createRoute(entryId))
                },
            )
        }

        // Entry detail screen
        composable(
            route = Screen.EntryDetail.route,
            arguments =
                listOf(
                    navArgument(Screen.ARG_ENTRY_ID) {
                        type = NavType.StringType
                    },
                ),
        ) {
            EntryDetailScreen(
                onBack = { navController.popBackStack() },
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
