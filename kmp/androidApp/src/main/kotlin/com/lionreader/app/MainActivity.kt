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
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.core.net.toUri
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation3.runtime.entryProvider
import androidx.navigation3.ui.NavDisplay
import com.lionreader.app.ui.EntryScreen
import com.lionreader.app.ui.HomeScreen
import com.lionreader.app.ui.HomeViewModel
import com.lionreader.app.ui.LionReaderTheme
import com.lionreader.app.ui.SettingsScreen
import com.lionreader.app.ui.SignInScreen
import com.lionreader.app.ui.isDark
import com.lionreader.shared.auth.AuthException
import kotlinx.coroutines.launch

private data object HomeKey

private data class EntryKey(val id: String)

private data object SettingsKey

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
                    graph.session.auth.completeAuthorization(data.toString(), pending)
                    // The local store belongs to whoever was signed in before
                    // (possibly another account or server); start clean.
                    graph.session.sync.reset()
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
            val request = graph.session.auth.authorizationRequest()
            graph.pendingAuthorization = request
            CustomTabsIntent.Builder().build().launchUrl(this@MainActivity, request.url.toUri())
        }
    }

    @Composable
    private fun App() {
        val session by graph.sessions.collectAsStateWithLifecycle()
        val signedIn by session.auth.signedIn.collectAsStateWithLifecycle()
        if (!signedIn) {
            SignInScreen(graph.serverUrl, signInError, ::startSignIn)
            return
        }
        val backStack = remember { mutableStateListOf<Any>(HomeKey) }
        val home = viewModel { HomeViewModel(graph) }
        NavDisplay(
            backStack = backStack,
            onBack = { backStack.removeLastOrNull() },
            entryProvider =
                entryProvider {
                    entry<HomeKey> {
                        HomeScreen(
                            model = home,
                            onOpen = { backStack.add(EntryKey(it)) },
                            onSettings = { backStack.add(SettingsKey) },
                        )
                    }
                    entry<EntryKey> { key ->
                        EntryScreen(graph, key.id, onBack = { backStack.removeLastOrNull() })
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
