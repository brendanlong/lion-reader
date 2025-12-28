package com.lionreader

import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import com.lionreader.data.repository.AuthRepository
import com.lionreader.di.AppConfig
import com.lionreader.ui.navigation.LionReaderNavGraph
import com.lionreader.ui.theme.LionReaderTheme
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject

/**
 * Single Activity that hosts all Compose screens.
 *
 * The @AndroidEntryPoint annotation allows Hilt to inject dependencies
 * into this activity. Follows single-activity architecture pattern where
 * navigation is handled by Jetpack Compose Navigation within this activity.
 */
@AndroidEntryPoint
class MainActivity : ComponentActivity() {

    @Inject
    lateinit var appConfig: AppConfig

    @Inject
    lateinit var authRepository: AuthRepository

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Verify Hilt injection is working
        Log.d("MainActivity", "Hilt injection verified - App name: ${appConfig.appName}")

        enableEdgeToEdge()
        setContent {
            LionReaderTheme {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background,
                ) {
                    LionReaderNavGraph(
                        authRepository = authRepository,
                        onUnauthorized = {
                            // Placeholder for handling 401 responses
                            // Will be expanded in a future phase
                            Log.d("MainActivity", "Received unauthorized response")
                        },
                    )
                }
            }
        }
    }
}
