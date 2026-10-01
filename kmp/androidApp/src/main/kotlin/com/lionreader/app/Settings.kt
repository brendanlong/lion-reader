package com.lionreader.app

import android.content.Context
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.floatPreferencesKey
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.core.stringSetPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.lionreader.shared.sync.RetentionPolicy
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

enum class ThemeChoice {
    SYSTEM,
    LIGHT,
    DARK,
    /** Dark on pure black, for OLED screens. */
    BLACK,
    EPAPER,
}

/** The web reader's font choices; `key` matches `assets/reader/appearance.json`. */
enum class ReaderFont(val key: String, val label: String, val cssFamily: String) {
    SYSTEM("system", "System", "sans-serif"),
    MERRIWEATHER("merriweather", "Merriweather", "'Merriweather', Georgia, serif"),
    LITERATA("literata", "Literata", "'Literata', Georgia, serif"),
    INTER("inter", "Inter", "'Inter', sans-serif"),
    SOURCE_SANS("source-sans", "Source Sans", "'Source Sans 3', sans-serif"),
}

enum class TextSize(val key: String, val label: String) {
    SMALL("small", "Small"),
    MEDIUM("medium", "Medium"),
    LARGE("large", "Large"),
    X_LARGE("x-large", "Extra large"),
}

/** Where narration audio comes from. */
enum class NarrationEngine {
    DEVICE,
    CLOUD,
}

/** Per-device settings, like the web's localStorage ones. */
data class AppSettings(
    val theme: ThemeChoice = ThemeChoice.SYSTEM,
    val font: ReaderFont = ReaderFont.SYSTEM,
    val textSize: TextSize = TextSize.MEDIUM,
    val justify: Boolean = false,
    val unreadOnly: Boolean = true,
    val retentionDays: Int = 30,
    /** Drawer tags shown with their feeds; the rest are collapsed. */
    val expandedTags: Set<String> = emptySet(),
    /** Leave feeds and tags with nothing unread out of the drawer. */
    val hideEmptyLists: Boolean = false,
    /** The text-to-speech voice's name; null for the engine's default. */
    val narrationVoice: String? = null,
    val narrationSpeed: Float = 1f,
    /** Keep the paragraph being read on screen. */
    val narrationAutoScroll: Boolean = true,
    val narrationEngine: NarrationEngine = NarrationEngine.DEVICE,
    /** The cloud voice model (`provider:model`) and voice; null for the server's defaults. */
    val cloudVoiceModel: String? = null,
    val cloudVoice: String? = null,
) {
    val retention: RetentionPolicy
        get() = RetentionPolicy(windowDays = retentionDays)
}

private val Context.settingsStore by preferencesDataStore("settings")

class SettingsRepository(private val context: Context) {
    private object Keys {
        val theme = stringPreferencesKey("theme")
        val font = stringPreferencesKey("font")
        val textSize = stringPreferencesKey("text_size")
        val justify = booleanPreferencesKey("justify")
        val unreadOnly = booleanPreferencesKey("unread_only")
        val retentionDays = intPreferencesKey("retention_days")
        val expandedTags = stringSetPreferencesKey("expanded_tags")
        val hideEmptyLists = booleanPreferencesKey("hide_empty_lists")
        val narrationVoice = stringPreferencesKey("narration_voice")
        val narrationSpeed = floatPreferencesKey("narration_speed")
        val narrationAutoScroll = booleanPreferencesKey("narration_auto_scroll")
        val narrationEngine = stringPreferencesKey("narration_engine")
        val cloudVoiceModel = stringPreferencesKey("cloud_voice_model")
        val cloudVoice = stringPreferencesKey("cloud_voice")
    }

    val settings: Flow<AppSettings> = context.settingsStore.data.map { it.toSettings() }

    suspend fun update(transform: (AppSettings) -> AppSettings) {
        context.settingsStore.edit { prefs ->
            val next = transform(prefs.toSettings())
            prefs[Keys.theme] = next.theme.name
            prefs[Keys.font] = next.font.name
            prefs[Keys.textSize] = next.textSize.name
            prefs[Keys.justify] = next.justify
            prefs[Keys.unreadOnly] = next.unreadOnly
            prefs[Keys.retentionDays] = next.retentionDays
            prefs[Keys.expandedTags] = next.expandedTags
            prefs[Keys.hideEmptyLists] = next.hideEmptyLists
            next.narrationVoice?.let { prefs[Keys.narrationVoice] = it }
                ?: prefs.remove(Keys.narrationVoice)
            prefs[Keys.narrationSpeed] = next.narrationSpeed
            prefs[Keys.narrationAutoScroll] = next.narrationAutoScroll
            prefs[Keys.narrationEngine] = next.narrationEngine.name
            next.cloudVoiceModel?.let { prefs[Keys.cloudVoiceModel] = it }
                ?: prefs.remove(Keys.cloudVoiceModel)
            next.cloudVoice?.let { prefs[Keys.cloudVoice] = it } ?: prefs.remove(Keys.cloudVoice)
        }
    }

    private fun Preferences.toSettings(): AppSettings {
        val defaults = AppSettings()
        return AppSettings(
            theme = enumOr(this[Keys.theme], defaults.theme),
            font = enumOr(this[Keys.font], defaults.font),
            textSize = enumOr(this[Keys.textSize], defaults.textSize),
            justify = this[Keys.justify] ?: defaults.justify,
            unreadOnly = this[Keys.unreadOnly] ?: defaults.unreadOnly,
            retentionDays = this[Keys.retentionDays] ?: defaults.retentionDays,
            expandedTags = this[Keys.expandedTags] ?: defaults.expandedTags,
            hideEmptyLists = this[Keys.hideEmptyLists] ?: defaults.hideEmptyLists,
            narrationVoice = this[Keys.narrationVoice],
            narrationSpeed = this[Keys.narrationSpeed] ?: defaults.narrationSpeed,
            narrationAutoScroll = this[Keys.narrationAutoScroll] ?: defaults.narrationAutoScroll,
            narrationEngine = enumOr(this[Keys.narrationEngine], defaults.narrationEngine),
            cloudVoiceModel = this[Keys.cloudVoiceModel],
            cloudVoice = this[Keys.cloudVoice],
        )
    }
}

private inline fun <reified T : Enum<T>> enumOr(name: String?, default: T): T =
    name?.let { runCatching { enumValueOf<T>(it) }.getOrNull() } ?: default
