package com.lionreader.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.lionreader.app.AppGraph
import com.lionreader.app.AppSettings
import com.lionreader.app.R
import com.lionreader.app.ReaderFont
import com.lionreader.app.TextSize
import com.lionreader.app.ThemeChoice
import kotlinx.coroutines.launch

private val RETENTION_CHOICES = listOf(7, 14, 30, 90)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(graph: AppGraph, onBack: () -> Unit, onSignOut: () -> Unit) {
    val settings by graph.currentSettings.collectAsStateWithLifecycle()
    val coroutines = rememberCoroutineScope()
    val context = LocalContext.current
    fun update(transform: (AppSettings) -> AppSettings) {
        coroutines.launch { graph.settings.update(transform) }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Settings") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(painterResource(R.drawable.ic_arrow_back), contentDescription = "Back")
                    }
                },
            )
        }
    ) { padding ->
        Column(
            modifier =
                Modifier.padding(padding)
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Section("Theme") {
                Choices(ThemeChoice.entries, settings.theme, { it.label }) { choice ->
                    update { it.copy(theme = choice) }
                }
            }
            Section("Font") {
                Choices(ReaderFont.entries, settings.font, { it.label }) { choice ->
                    update { it.copy(font = choice) }
                }
            }
            Section("Text size") {
                Choices(TextSize.entries, settings.textSize, { it.label }) { choice ->
                    update { it.copy(textSize = choice) }
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Justify text", modifier = Modifier.weight(1f))
                Switch(
                    checked = settings.justify,
                    onCheckedChange = { value -> update { it.copy(justify = value) } },
                )
            }
            HorizontalDivider()
            Section("Keep offline") {
                Text(
                    "Articles older than this are removed from the device. Starred and saved articles are always kept.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Choices(RETENTION_CHOICES, settings.retentionDays, { "$it days" }) { days ->
                    update { it.copy(retentionDays = days) }
                }
            }
            HorizontalDivider()
            Section("Account") {
                Text(graph.serverUrl, style = MaterialTheme.typography.bodyMedium)
                OutlinedButton(
                    onClick = {
                        context.startActivity(
                            android.content.Intent(
                                android.content.Intent.ACTION_VIEW,
                                "${graph.serverUrl}/settings".toUri(),
                            )
                        )
                    }
                ) {
                    Text("Account settings on the web")
                }
                OutlinedButton(onClick = onSignOut) { Text("Sign out") }
            }
        }
    }
}

private val ThemeChoice.label: String
    get() =
        when (this) {
            ThemeChoice.SYSTEM -> "System"
            ThemeChoice.LIGHT -> "Light"
            ThemeChoice.DARK -> "Dark"
            ThemeChoice.EPAPER -> "E-paper"
        }

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
        Text(title, style = MaterialTheme.typography.titleSmall)
        content()
    }
}

@Composable
private fun <T> Choices(
    options: List<T>,
    selected: T,
    label: (T) -> String,
    onSelect: (T) -> Unit,
) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        options.forEach { option ->
            FilterChip(
                selected = option == selected,
                onClick = { onSelect(option) },
                label = { Text(label(option)) },
            )
        }
    }
}
