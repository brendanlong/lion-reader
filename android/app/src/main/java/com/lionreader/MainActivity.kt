package com.lionreader

import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import com.lionreader.di.AppConfig
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

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Verify Hilt injection is working
        Log.d("MainActivity", "Hilt injection verified - App name: ${appConfig.appName}")

        enableEdgeToEdge()
        setContent {
            LionReaderTheme {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background
                ) {
                    LionReaderContent()
                }
            }
        }
    }
}

@Composable
fun LionReaderContent() {
    Scaffold(modifier = Modifier.fillMaxSize()) { innerPadding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding),
            contentAlignment = Alignment.Center
        ) {
            Text(
                text = "Lion Reader",
                style = MaterialTheme.typography.headlineLarge
            )
        }
    }
}

@Preview(showBackground = true)
@Composable
fun LionReaderContentPreview() {
    LionReaderTheme {
        LionReaderContent()
    }
}
