package com.lionreader.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.lionreader.shared.account.ServerUrlInput
import com.lionreader.shared.account.parseServerUrl

/**
 * [onSignIn] gets the server's checked URL ([parseServerUrl]); [allowHttp] for debug builds, whose
 * dev servers are http.
 */
@Composable
fun SignInScreen(
    serverUrl: String,
    error: String?,
    allowHttp: Boolean,
    onSignIn: (serverUrl: String) -> Unit,
) {
    var server by rememberSaveable { mutableStateOf(serverUrl) }
    var editingServer by rememberSaveable { mutableStateOf(false) }
    var serverError by rememberSaveable { mutableStateOf<String?>(null) }
    Scaffold { padding ->
        Column(
            modifier = Modifier.padding(padding).fillMaxSize().padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text("Lion Reader", style = MaterialTheme.typography.headlineLarge)
            Text(
                "Sign in with your Lion Reader account. Your articles are kept on this device so you can read offline.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            error?.let {
                Text(
                    it,
                    color = MaterialTheme.colorScheme.error,
                    // It arrives when the browser hands back, with nothing focused on it.
                    modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                )
            }
            Button(
                onClick = {
                    when (val checked = parseServerUrl(server, allowHttp)) {
                        is ServerUrlInput.Valid -> {
                            serverError = null
                            onSignIn(checked.url)
                        }
                        is ServerUrlInput.Invalid -> {
                            serverError = checked.message
                            editingServer = true
                        }
                    }
                },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("Sign in")
            }
            if (editingServer) {
                OutlinedTextField(
                    value = server,
                    onValueChange = {
                        server = it
                        serverError = null
                    },
                    label = { Text("Server") },
                    isError = serverError != null,
                    supportingText = serverError?.let { { Text(it) } },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                    modifier = Modifier.fillMaxWidth(),
                )
            } else {
                TextButton(onClick = { editingServer = true }) { Text("Server: $server") }
            }
        }
    }
}
