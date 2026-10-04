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
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
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
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.lionreader.app.AppGraph
import com.lionreader.app.R
import com.lionreader.app.narration.VoiceOption
import com.lionreader.app.openWebPage
import com.lionreader.shared.api.VoiceModel
import com.lionreader.shared.api.VoiceModels
import com.lionreader.shared.settings.AppSettings
import com.lionreader.shared.settings.NarrationEngine
import com.lionreader.shared.settings.ReaderFont
import com.lionreader.shared.settings.TextSize
import com.lionreader.shared.settings.ThemeChoice
import kotlin.math.roundToInt
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
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
        val scroll = rememberScrollState()
        Column(
            modifier =
                Modifier.padding(padding)
                    .fillMaxSize()
                    .scrollbar { scroll.scrollIndicatorState }
                    .verticalScroll(scroll)
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
            SettingSwitch("Justify text", settings.justify) { value ->
                update { it.copy(justify = value) }
            }
            HorizontalDivider()
            NarrationSettings(graph, settings, ::update)
            HorizontalDivider()
            SettingSwitch("Hide feeds and tags with no unread articles", settings.hideEmptyLists) {
                value ->
                update { it.copy(hideEmptyLists = value) }
            }
            HorizontalDivider()
            Section("E-readers") {
                SettingSwitch("Animations", settings.animations) { value ->
                    update { it.copy(animations = value) }
                }
                SettingSwitch(
                    "Scroll a page at a time",
                    settings.pageScrolling,
                    note = "Swiping up or down moves articles and lists most of a screen at once.",
                ) { value ->
                    update { it.copy(pageScrolling = value) }
                }
                SettingSwitch(
                    "Turn pages with the volume buttons",
                    settings.volumeKeyPaging,
                    note = "Except while narration is playing.",
                ) { value ->
                    update { it.copy(volumeKeyPaging = value) }
                }
            }
            HorizontalDivider()
            Section("Keep offline") {
                Text(
                    "Articles older than this are removed from the device, except starred and saved ones and ones you read or marked unread in that time.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Choices(RETENTION_CHOICES, settings.retentionDays, { "$it days" }) { days ->
                    update { it.copy(retentionDays = days) }
                }
            }
            HorizontalDivider()
            Section("Account") {
                Text(graph.accounts.serverUrl, style = MaterialTheme.typography.bodyMedium)
                OutlinedButton(
                    onClick = { context.openWebPage("${graph.accounts.serverUrl}/settings") }
                ) {
                    Text("Account settings on the web")
                }
                SignOutButton(graph.accounts::unsentChangesAfterFlush, onSignOut)
            }
        }
    }
}

/**
 * Signs out once the unsent changes are sent, or, if some can't be, once the user agrees to lose
 * them.
 */
@Composable
internal fun SignOutButton(unsentAfterFlush: suspend () -> Long, onSignOut: () -> Unit) {
    val coroutines = rememberCoroutineScope()
    var checking by remember { mutableStateOf(false) }
    var unsent by rememberSaveable { mutableStateOf<Long?>(null) }
    OutlinedButton(
        onClick = {
            checking = true
            coroutines.launch {
                val left =
                    try {
                        unsentAfterFlush()
                    } finally {
                        checking = false
                    }
                if (left == 0L) onSignOut() else unsent = left
            }
        },
        enabled = !checking,
    ) {
        Text(if (checking) "Sending changes…" else "Sign out")
    }
    unsent?.let { count ->
        AlertDialog(
            onDismissRequest = { unsent = null },
            title = { Text("Sign out?") },
            text = { Text(unsentChangesWarning(count)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        unsent = null
                        onSignOut()
                    }
                ) {
                    Text("Sign out")
                }
            },
            dismissButton = { TextButton(onClick = { unsent = null }) { Text("Cancel") } },
        )
    }
}

private fun unsentChangesWarning(count: Long): String =
    if (count == 1L) "1 change hasn't been sent and will be lost."
    else "$count changes haven't been sent and will be lost."

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
    val account by graph.accounts.account.collectAsStateWithLifecycle()
    // What narration last heard (it works offline too), until the server answers again.
    val known by
        remember(account) { account?.voiceModels ?: MutableStateFlow(null) }
            .collectAsStateWithLifecycle()
    var asked by remember(account) { mutableStateOf(false) }
    LaunchedEffect(account) {
        try {
            account?.fetchVoiceModels(settings.cloudVoiceModel, settings.cloudVoice)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {}
        asked = true
    }
    val cloud = known ?: VoiceModels(emptyList(), "").takeIf { asked }
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
                val defaultModel = cloud?.defaultModel
                val resolved = cloud?.resolve(settings.cloudVoiceModel, settings.cloudVoice)
                if (resolved == null) {
                    Text(
                        if (cloud == null) "Loading cloud voices…"
                        else
                            "Cloud voices need a cloud voice provider's key (set on the web) and a connection.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                } else {
                    val (model, voice) = resolved
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
                    // Only the voice: a model left on the default follows the server's default.
                    Picker(model.voiceName(voice), model.voices, { it.name }) { choice ->
                        update { it.copy(cloudVoice = choice.id) }
                    }
                    // Saved when the drag ends, not on every step of it.
                    var pause by
                        remember(settings.cloudVoicePauseSeconds) {
                            mutableFloatStateOf(settings.cloudVoicePauseSeconds)
                        }
                    Text(
                        "Pause between chunks: ${pauseLabel(pause)}",
                        style = MaterialTheme.typography.labelLarge,
                    )
                    Slider(
                        value = pause,
                        // In 0.05 s: keys and steps move by one. Rounded, since 9 steps of 0.05f
                        // isn't quite 0.45f.
                        onValueChange = {
                            pause = (it * STEPS_PER_SECOND).roundToInt() / STEPS_PER_SECOND
                        },
                        valueRange = 0f..MAX_PAUSE,
                        steps = (MAX_PAUSE * STEPS_PER_SECOND).roundToInt() - 1,
                        onValueChangeFinished = {
                            update { it.copy(cloudVoicePauseSeconds = pause) }
                        },
                        // A tick per step would be forty.
                        colors =
                            SliderDefaults.colors(
                                activeTickColor = Color.Transparent,
                                inactiveTickColor = Color.Transparent,
                            ),
                        modifier =
                            Modifier.semantics {
                                contentDescription = "Pause between chunks"
                                stateDescription = pauseLabel(pause)
                            },
                    )
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
    SettingSwitch("Keep the paragraph being read on screen", settings.narrationAutoScroll) { value
        ->
        update { it.copy(narrationAutoScroll = value) }
    }
}

/** The server takes up to 2 seconds. */
private const val MAX_PAUSE = 2f
private const val STEPS_PER_SECOND = 20f

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

/** The label and the switch are one control (and one TalkBack stop). */
@Composable
internal fun SettingSwitch(
    label: String,
    checked: Boolean,
    note: String? = null,
    onChange: (Boolean) -> Unit,
) {
    Row(
        Modifier.fillMaxWidth()
            .toggleable(value = checked, role = Role.Switch, onValueChange = onChange),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(label)
            note?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        Switch(checked = checked, onCheckedChange = null)
    }
}

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
        Text(
            title,
            style = MaterialTheme.typography.titleSmall,
            modifier = Modifier.semantics { heading() },
        )
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
