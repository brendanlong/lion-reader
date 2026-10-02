package com.lionreader.app

import android.content.Context
import androidx.datastore.preferences.core.MutablePreferences
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
    /** Off for e-readers, where animation only smears. */
    val animations: Boolean = true,
    /** Swipes move lists and articles a page at a time (for e-readers), rather than scrolling. */
    val pageScrolling: Boolean = false,
    /** The volume buttons turn pages in lists and articles. */
    val volumeKeyPaging: Boolean = false,
    /** The text-to-speech voice's name; null for the engine's default. */
    val narrationVoice: String? = null,
    val narrationSpeed: Float = 1f,
    /** Keep the paragraph being read on screen. */
    val narrationAutoScroll: Boolean = true,
    val narrationEngine: NarrationEngine = NarrationEngine.DEVICE,
    /** The cloud voice model (`provider:model`) and voice; null for the server's defaults. */
    val cloudVoiceModel: String? = null,
    val cloudVoice: String? = null,
    /** Silence after each chunk of cloud speech. */
    val cloudVoicePauseSeconds: Float = 0.6f,
) {
    val retention: RetentionPolicy
        get() = RetentionPolicy(windowDays = retentionDays)
}

private val Context.settingsStore by preferencesDataStore("settings")

/** [defaults]: what a setting the user hasn't changed is ([deviceDefaults]). */
class SettingsRepository(private val context: Context, val defaults: AppSettings) {
    val settings: Flow<AppSettings> = context.settingsStore.data.map { it.toSettings(defaults) }

    suspend fun update(transform: (AppSettings) -> AppSettings) {
        context.settingsStore.edit { prefs -> prefs.store(transform(prefs.toSettings(defaults))) }
    }
}

/**
 * Where each setting is kept: its key, and how to read it from and set it on [AppSettings]. A new
 * setting needs a line here as well as its field (SettingsStorageTest checks there's one per
 * field). Keys and stored types are what's on devices already; don't change them.
 */
internal val STORED_SETTINGS: List<Stored<*>> =
    listOf(
        enumStored("theme", { theme }) { copy(theme = it) },
        enumStored("font", { font }) { copy(font = it) },
        enumStored("text_size", { textSize }) { copy(textSize = it) },
        Stored(booleanPreferencesKey("justify"), { justify }) { copy(justify = it) },
        Stored(booleanPreferencesKey("unread_only"), { unreadOnly }) { copy(unreadOnly = it) },
        Stored(intPreferencesKey("retention_days"), { retentionDays }) {
            copy(retentionDays = it)
        },
        Stored(stringSetPreferencesKey("expanded_tags"), { expandedTags }) {
            copy(expandedTags = it)
        },
        Stored(booleanPreferencesKey("hide_empty_lists"), { hideEmptyLists }) {
            copy(hideEmptyLists = it)
        },
        Stored(booleanPreferencesKey("animations"), { animations }) { copy(animations = it) },
        Stored(booleanPreferencesKey("page_scrolling"), { pageScrolling }) {
            copy(pageScrolling = it)
        },
        Stored(booleanPreferencesKey("volume_key_paging"), { volumeKeyPaging }) {
            copy(volumeKeyPaging = it)
        },
        Stored(stringPreferencesKey("narration_voice"), { narrationVoice }) {
            copy(narrationVoice = it)
        },
        Stored(floatPreferencesKey("narration_speed"), { narrationSpeed }) {
            copy(narrationSpeed = it)
        },
        Stored(booleanPreferencesKey("narration_auto_scroll"), { narrationAutoScroll }) {
            copy(narrationAutoScroll = it)
        },
        enumStored("narration_engine", { narrationEngine }) { copy(narrationEngine = it) },
        Stored(stringPreferencesKey("cloud_voice_model"), { cloudVoiceModel }) {
            copy(cloudVoiceModel = it)
        },
        Stored(stringPreferencesKey("cloud_voice"), { cloudVoice }) { copy(cloudVoice = it) },
        Stored(floatPreferencesKey("cloud_voice_pause_seconds"), { cloudVoicePauseSeconds }) {
            copy(cloudVoicePauseSeconds = it)
        },
    )

internal fun Preferences.toSettings(defaults: AppSettings = AppSettings()): AppSettings =
    STORED_SETTINGS.fold(defaults) { settings, stored -> stored.read(this, settings) }

internal fun MutablePreferences.store(settings: AppSettings) {
    STORED_SETTINGS.forEach { it.write(this, settings) }
}

/**
 * A setting kept under [key]. A null value isn't stored (the key is removed), so it reads back as
 * the default: right for the nullable settings, whose defaults are null.
 */
internal class Stored<S : Any>(
    private val key: Preferences.Key<S>,
    private val get: AppSettings.() -> S?,
    private val set: AppSettings.(S) -> AppSettings,
) {
    /** A missing value leaves the default. */
    fun read(prefs: Preferences, settings: AppSettings): AppSettings =
        prefs[key]?.let { settings.set(it) } ?: settings

    fun write(prefs: MutablePreferences, settings: AppSettings) {
        settings.get()?.let { prefs[key] = it } ?: prefs.remove(key)
    }
}

/** An enum, kept by name; a name it doesn't know (an older or newer app's) leaves the default. */
private inline fun <reified E : Enum<E>> enumStored(
    name: String,
    noinline get: AppSettings.() -> E,
    noinline set: AppSettings.(E) -> AppSettings,
) =
    Stored(stringPreferencesKey(name), { get().name }) { stored ->
        runCatching { enumValueOf<E>(stored) }.getOrNull()?.let { set(it) } ?: this
    }
