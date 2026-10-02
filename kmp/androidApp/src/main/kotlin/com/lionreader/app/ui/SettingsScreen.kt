package com.lionreader.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.lionreader.app.AppGraph
import com.lionreader.app.AppSettings
import com.lionreader.app.NarrationEngine
import com.lionreader.app.R
import com.lionreader.app.ReaderFont
import com.lionreader.app.TextSize
import com.lionreader.app.ThemeChoice
import com.lionreader.app.narration.VoiceOption
import com.lionreader.shared.api.VoiceModel
import com.lionreader.shared.api.VoiceModels
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
            NarrationSettings(graph, settings, ::update)
            HorizontalDivider()
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "Hide feeds and tags with no unread articles",
                    modifier = Modifier.weight(1f),
                )
                Switch(
                    checked = settings.hideEmptyLists,
                    onCheckedChange = { value -> update { it.copy(hideEmptyLists = value) } },
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

@Composable
private fun NarrationSettings(
    graph: AppGraph,
    settings: AppSettings,
    update: ((AppSettings) -> AppSettings) -> Unit,
) {
    val deviceVoices by
        produceState<List<VoiceOption>?>(null) {
            value = runCatching { graph.systemTts.voices() }.getOrDefault(emptyList())
        }
    // Null while loading; empty when this account has none (no speech provider
    // key) or the server can't be reached.
    val account by graph.account.collectAsStateWithLifecycle()
    val cloud by
        produceState<VoiceModels?>(null, account) {
            value =
                runCatching { account?.connection?.api?.voiceModels() }.getOrNull()
                    ?: VoiceModels(emptyList(), "")
        }
    Section("Narration voices") {
        val engines =
            if (
                cloud?.models.isNullOrEmpty() && settings.narrationEngine != NarrationEngine.CLOUD
            ) {
                listOf(NarrationEngine.DEVICE)
            } else {
                NarrationEngine.entries
            }
        if (engines.size > 1) {
            Choices(engines, settings.narrationEngine, { it.label }) { engine ->
                update { it.copy(narrationEngine = engine) }
            }
        }
        when (settings.narrationEngine) {
            NarrationEngine.DEVICE -> {
                val voices = deviceVoices
                Picker(
                    label =
                        when {
                            voices == null -> "Loading voices…"
                            voices.isEmpty() -> "No text-to-speech voices installed"
                            else ->
                                voices.firstOrNull { it.name == settings.narrationVoice }?.label
                                    ?: "Device default"
                        },
                    options = listOf(null) + voices.orEmpty(),
                    optionLabel = { voice ->
                        when {
                            voice == null -> "Device default"
                            voice.online -> "${voice.label} (online)"
                            else -> voice.label
                        }
                    },
                ) { voice ->
                    update { it.copy(narrationVoice = voice?.name) }
                }
            }
            NarrationEngine.CLOUD -> {
                val models = cloud?.models.orEmpty()
                val defaultModel =
                    models.firstOrNull { it.id == cloud?.defaultModelId } ?: models.firstOrNull()
                val model = models.firstOrNull { it.id == settings.cloudVoiceModel } ?: defaultModel
                if (model == null) {
                    Text(
                        if (cloud == null) "Loading cloud voices…"
                        else
                            "Cloud voices need a cloud voice provider's key (set on the web) and a connection.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                } else {
                    if (models.size > 1) {
                        val defaultLabel = "Default (${modelLabel(defaultModel ?: model)})"
                        // null is "Default": it follows the server's default if that changes.
                        Picker<VoiceModel?>(
                            if (settings.cloudVoiceModel == null) defaultLabel
                            else modelLabel(model),
                            listOf(null) + models.sortedBy { it.providerDisplayName },
                            { it?.displayName ?: defaultLabel },
                            group = { it?.providerDisplayName },
                        ) { choice ->
                            // Voice names are per model.
                            val keepVoice = (choice ?: defaultModel)?.id == model.id
                            update {
                                it.copy(
                                    cloudVoiceModel = choice?.id,
                                    cloudVoice = it.cloudVoice.takeIf { keepVoice },
                                )
                            }
                        }
                    }
                    if (settings.cloudVoiceModel != null && model.id != settings.cloudVoiceModel) {
                        Text(
                            "Your chosen model isn't available, so the default is used.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    val voice = settings.cloudVoice?.takeIf(model::hasVoice) ?: model.defaultVoice
                    // Only the voice: a model left on the default follows the server's default.
                    Picker(model.voiceName(voice), model.voices, { it.name }) { choice ->
                        update { it.copy(cloudVoice = choice.id) }
                    }
                    Text("Pause between chunks", style = MaterialTheme.typography.labelLarge)
                    Choices(
                        CLOUD_VOICE_PAUSES,
                        settings.cloudVoicePauseSeconds,
                        ::pauseLabel,
                    ) { pause ->
                        update { it.copy(cloudVoicePauseSeconds = pause) }
                    }
                    Text(
                        "Articles are spoken a few sentences at a time. Some voices run those " +
                            "pieces together; this adds a pause after each one.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(
                        "Cloud voices send the text being read to ${model.displayName} through " +
                            "${model.providerDisplayName}.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
    Section("Narration speed") {
        Choices(NARRATION_SPEEDS, settings.narrationSpeed, ::speedLabel, graph::setNarrationSpeed)
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text("Keep the paragraph being read on screen", modifier = Modifier.weight(1f))
        Switch(
            checked = settings.narrationAutoScroll,
            onCheckedChange = { value -> update { it.copy(narrationAutoScroll = value) } },
        )
    }
}

private val CLOUD_VOICE_PAUSES = listOf(0f, 0.25f, 0.5f, 0.75f, 1f, 1.5f, 2f)

private fun pauseLabel(seconds: Float): String =
    if (seconds == 0f) "None" else "${shortNumber(seconds)} s"

private val NarrationEngine.label: String
    get() =
        when (this) {
            NarrationEngine.DEVICE -> "Device"
            NarrationEngine.CLOUD -> "Cloud"
        }

/** A button showing [label] that opens a menu of [options]. */
@Composable
private fun <T> Picker(
    label: String,
    options: List<T>,
    optionLabel: (T) -> String,
    /** A heading shown above each run of options that share one. */
    group: (T) -> String? = { null },
    onPick: (T) -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    Box {
        OutlinedButton(onClick = { open = true }, enabled = options.isNotEmpty()) {
            Text(label, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            options.forEachIndexed { index, option ->
                val title = group(option)
                if (title != null && (index == 0 || group(options[index - 1]) != title)) {
                    Text(
                        title,
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.primary,
                        modifier =
                            Modifier.padding(horizontal = 12.dp, vertical = 8.dp).semantics {
                                heading()
                            },
                    )
                }
                DropdownMenuItem(
                    text = { Text(optionLabel(option)) },
                    onClick = {
                        open = false
                        onPick(option)
                    },
                )
            }
        }
    }
}

/** Both providers serve a "Kokoro 82M", so name the provider too. */
private fun modelLabel(model: VoiceModel): String =
    "${model.displayName} · ${model.providerDisplayName}"

private val ThemeChoice.label: String
    get() =
        when (this) {
            ThemeChoice.SYSTEM -> "System"
            ThemeChoice.LIGHT -> "Light"
            ThemeChoice.DARK -> "Dark"
            ThemeChoice.BLACK -> "Black"
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
