package com.lionreader.app

import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.KeyEvent
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.browser.auth.AuthTabIntent
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.adaptive.ExperimentalMaterial3AdaptiveApi
import androidx.compose.material3.adaptive.currentWindowAdaptiveInfo
import androidx.compose.material3.adaptive.layout.calculatePaneScaffoldDirective
import androidx.compose.material3.adaptive.navigation.BackNavigationBehavior
import androidx.compose.material3.adaptive.navigation3.ListDetailSceneStrategy
import androidx.compose.material3.adaptive.navigation3.rememberListDetailSceneStrategy
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.createLifecycleAwareWindowRecomposer
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
import com.lionreader.app.ui.AppMotion
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
    private val motion by lazy { AppMotion(this) }
    /** The volume button whose press turned a page: its repeats and release are ours too. */
    private var pagingKey: Int? = null

    /**
     * Sign-in in an Auth Tab: the browser hands the redirect straight back here, so no other app
     * (the debug build, say) can be picked to open it. A browser without Auth Tabs opens a Custom
     * Tab instead, whose redirect arrives as the App Link ([onNewIntent]); its closing then comes
     * back here as a cancel, which leaves the sign-in to that link. If the browser can't verify the
     * redirect is this app's, it retries in a Custom Tab.
     */
    private val authTab =
        AuthTabIntent.registerActivityResultLauncher(this) { result ->
            when (result.resultCode) {
                AuthTabIntent.RESULT_OK -> result.resultUri?.let(::completeSignIn)
                AuthTabIntent.RESULT_VERIFICATION_FAILED,
                AuthTabIntent.RESULT_VERIFICATION_TIMED_OUT -> authTabUrl?.let(::openCustomTab)
                // Closed by the user, or by a Custom Tab's App Link (see above).
                AuthTabIntent.RESULT_CANCELED,
                AuthTabIntent.RESULT_UNKNOWN_CODE -> {}
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        handleSignInCallback(intent)
        // The window's recomposer, but with the app's animation speed (AppMotion) rather than
        // only the system's.
        val recomposer = window.decorView.createLifecycleAwareWindowRecomposer(motion, lifecycle)
        setContent(parent = recomposer) {
            val settings by graph.currentSettings.collectAsStateWithLifecycle()
            SideEffect { motion.enabled = settings.animates }
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

    override fun onResume() {
        super.onResume()
        motion.refresh()
    }

    /**
     * The volume buttons turn pages ([AppGraph.pageTurns]) when the settings say so, except while
     * narration plays; otherwise, and with nothing to page on screen, they set the volume.
     */
    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        val direction = pageDirection(keyCode) ?: return super.onKeyDown(keyCode, event)
        if (event.repeatCount == 0) {
            pagingKey = keyCode.takeIf {
                graph.currentSettings.value.volumeKeyPaging &&
                    !graph.narrating &&
                    graph.pageTurns.turn(direction)
            }
        }
        return pagingKey == keyCode || super.onKeyDown(keyCode, event)
    }

    override fun onKeyUp(keyCode: Int, event: KeyEvent): Boolean {
        if (pageDirection(keyCode) == null || pagingKey != keyCode) {
            return super.onKeyUp(keyCode, event)
        }
        pagingKey = null
        return true
    }

    private fun pageDirection(keyCode: Int): Int? =
        when (keyCode) {
            KeyEvent.KEYCODE_VOLUME_DOWN -> 1
            KeyEvent.KEYCODE_VOLUME_UP -> -1
            else -> null
        }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleSignInCallback(intent)
    }

    /** The App Link redirect from the server's authorization endpoint. */
    private fun handleSignInCallback(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.path != BuildConfig.SIGN_IN_CALLBACK_PATH) return
        completeSignIn(data)
    }

    private fun completeSignIn(data: Uri) {
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

    /** What the Auth Tab was opened on, to retry in a Custom Tab. */
    private var authTabUrl: Uri? = null

    private fun openCustomTab(url: Uri) = CustomTabsIntent.Builder().build().launchUrl(this, url)

    private fun startSignIn(serverUrl: String) {
        if (serverUrl != graph.serverUrl) graph.setServerUrl(serverUrl)
        lifecycleScope.launch {
            val request = graph.connection.value.auth.authorizationRequest()
            graph.pendingAuthorization = request
            val url = request.url.toUri()
            // Auth Tabs only return https redirects on the default port (a dev
            // server is http, a self-hosted one may have a port).
            if (url.scheme == "https" && url.port == -1) {
                authTabUrl = url
                AuthTabIntent.Builder()
                    .build()
                    .launch(authTab, url, url.host!!, BuildConfig.SIGN_IN_CALLBACK_PATH)
            } else {
                openCustomTab(url)
            }
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
        val transitions = remember(settings.animates) { ScreenTransitions(settings.animates) }
        // Side by side where there's room (tablets, foldables, landscape).
        // Back closes the article beside the list, as it does full screen.
        val listDetail =
            rememberListDetailSceneStrategy<NavKey>(
                backNavigationBehavior = BackNavigationBehavior.PopLatest
            )
        val twoPane =
            calculatePaneScaffoldDirective(currentWindowAdaptiveInfo()).maxHorizontalPartitions > 1
        val articleOpen = backStack.any { it is EntryKey }
        // Narration is of the article on screen: closing the article view ends it
        // (only closing it, not opening the app without one).
        var hadArticle by remember { mutableStateOf(articleOpen) }
        LaunchedEffect(articleOpen) {
            if (!articleOpen) home.shownClosed()
            if (hadArticle && !articleOpen && graph.narrator.state.value != null) {
                graph.narrator.stop()
            }
            hadArticle = articleOpen
        }
        NavDisplay(
            backStack = backStack,
            // Behind the panes (and the gap between them), which don't all paint their own.
            modifier = Modifier.background(MaterialTheme.colorScheme.background),
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
                            showSelection = twoPane,
                            onOpen = { id ->
                                // Replacing the one beside the list, when it's shown.
                                backStack.removeAll { it is EntryKey }
                                backStack.add(EntryKey.openedFrom(id, home.shownIds()))
                            },
                            onSettings = { backStack.add(SettingsKey) },
                            pageScrolling = settings.pageScrolling,
                            pageTurns = graph.pageTurns,
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
                            besideList = twoPane,
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
