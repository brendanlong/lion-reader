package com.lionreader.app

import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.adaptive.ExperimentalMaterial3AdaptiveApi
import androidx.compose.material3.adaptive.navigation3.ListDetailSceneStrategy
import androidx.compose.material3.adaptive.navigation3.rememberListDetailSceneStrategy
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.core.net.toUri
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation3.runtime.NavKey
import androidx.navigation3.runtime.entryProvider
import androidx.navigation3.runtime.rememberNavBackStack
import androidx.navigation3.ui.NavDisplay
import com.lionreader.app.ui.CurrentNarrationBar
import com.lionreader.app.ui.EntryScreen
import com.lionreader.app.ui.HomeScreen
import com.lionreader.app.ui.HomeViewModel
import com.lionreader.app.ui.LionReaderTheme
import com.lionreader.app.ui.ScreenTransitions
import com.lionreader.app.ui.SettingsScreen
import com.lionreader.app.ui.SignInScreen
import com.lionreader.app.ui.isDark
import com.lionreader.shared.auth.AuthException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private var signInError by mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        handleSignInCallback(intent)
        setContent {
            val settings by graph.currentSettings.collectAsStateWithLifecycle()
            // System bar icons follow the app's theme, which may differ from the system's.
            val dark = settings.theme.isDark(isSystemInDarkTheme())
            LaunchedEffect(dark) {
                val style =
                    if (dark) SystemBarStyle.dark(Color.TRANSPARENT)
                    else SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT)
                enableEdgeToEdge(statusBarStyle = style, navigationBarStyle = style)
            }
            LionReaderTheme(settings.theme) { App() }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleSignInCallback(intent)
    }

    /** The App Link redirect from the server's authorization endpoint. */
    private fun handleSignInCallback(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.path != "/oauth/app-callback") return
        val pending = graph.pendingAuthorization ?: return
        graph.pendingAuthorization = null
        lifecycleScope.launch {
            signInError =
                try {
                    graph.connection.value.auth.completeAuthorization(data.toString(), pending)
                    // Opens this account's own database (another account's
                    // data is deleted, the same account's kept).
                    graph.signedIn()
                    SyncScheduler.syncNow(this@MainActivity)
                    null
                } catch (e: AuthException) {
                    e.message
                } catch (e: java.io.IOException) {
                    "Couldn't reach the server"
                } catch (e: Exception) {
                    if (e is kotlinx.coroutines.CancellationException) throw e
                    "Sign-in failed"
                }
        }
    }

    private fun startSignIn(serverUrl: String) {
        if (serverUrl != graph.serverUrl) graph.setServerUrl(serverUrl)
        lifecycleScope.launch {
            val request = graph.connection.value.auth.authorizationRequest()
            graph.pendingAuthorization = request
            CustomTabsIntent.Builder().build().launchUrl(this@MainActivity, request.url.toUri())
        }
    }

    @Composable
    private fun App() {
        val connection by graph.connection.collectAsStateWithLifecycle()
        val signedIn by connection.auth.signedIn.collectAsStateWithLifecycle()
        val current by graph.account.collectAsStateWithLifecycle()
        val account = current
        if (!signedIn) {
            SignInScreen(graph.serverUrl, signInError, ::startSignIn)
            return
        }
        if (account == null || account.connection !== connection) {
            // Signed in, but which account isn't settled yet (e.g. the
            // /auth/me call failed offline); keep trying.
            LaunchedEffect(connection) {
                while (graph.account.value?.connection !== connection) {
                    runCatching { graph.signedIn() }
                    delay(5_000)
                }
            }
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator()
            }
            return
        }
        key(account.dbName) { AccountApp(account) }
    }

    @OptIn(ExperimentalMaterial3AdaptiveApi::class)
    @Composable
    private fun AccountApp(account: AccountSession) {
        val lifecycle = LocalLifecycleOwner.current.lifecycle
        LaunchedEffect(account) {
            lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { account.followServer() }
        }
        val backStack = rememberNavBackStack(HomeKey)
        val home = viewModel(key = account.dbName) { HomeViewModel(graph, account) }
        val settings by graph.currentSettings.collectAsStateWithLifecycle()
        val transitions = remember(settings.theme) { ScreenTransitions(settings.theme) }
        // Side by side where there's room (tablets, foldables, landscape).
        val listDetail = rememberListDetailSceneStrategy<NavKey>()
        val articleOpen = backStack.any { it is EntryKey }
        LaunchedEffect(articleOpen) { if (!articleOpen) home.shownClosed() }
        NavDisplay(
            backStack = backStack,
            sceneStrategies = listOf(listDetail),
            onBack = { backStack.removeLastOrNull() },
            transitionSpec = { transitions.forward },
            popTransitionSpec = { transitions.back },
            predictivePopTransitionSpec = { transitions.back },
            entryProvider =
                entryProvider {
                    entry<HomeKey>(
                        metadata =
                            ListDetailSceneStrategy.listPane(
                                detailPlaceholder = { NoArticlePlaceholder() }
                            )
                    ) {
                        HomeScreen(
                            model = home,
                            onOpen = { id ->
                                // Replacing the one beside the list, when it's shown.
                                backStack.removeAll { it is EntryKey }
                                backStack.add(EntryKey.openedFrom(id, home.shownIds()))
                            },
                            onSettings = { backStack.add(SettingsKey) },
                            bottomBar = {
                                // The mini player: tapping the title opens the article.
                                // Not beside an article, which has its own.
                                if (!articleOpen)
                                    CurrentNarrationBar(graph) { state ->
                                        backStack.add(
                                            EntryKey.openedFrom(state.entryId, state.queue)
                                        )
                                    }
                            },
                        )
                    }
                    // Keyed by id alone: the default key is the whole key's
                    // string, list included, and ends up in saved state.
                    entry<EntryKey>(
                        { key: EntryKey -> key.id },
                        metadata = ListDetailSceneStrategy.detailPane(),
                    ) { key ->
                        EntryScreen(
                            graph,
                            account,
                            ids = key.listIds,
                            startId = key.id,
                            onShown = home::opened,
                            onBack = { backStack.removeLastOrNull() },
                            onOpenElsewhere = { state ->
                                backStack.add(EntryKey.openedFrom(state.entryId, state.queue))
                            },
                        )
                    }
                    entry<SettingsKey> {
                        SettingsScreen(
                            graph,
                            onBack = { backStack.removeLastOrNull() },
                            onSignOut = graph::signOut,
                        )
                    }
                },
        )
    }
}

@Composable
private fun NoArticlePlaceholder() {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text(
            "Choose an article",
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
