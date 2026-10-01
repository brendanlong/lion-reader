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
    val settings: Flow<AppSettings> = context.settingsStore.data.map { it.toSettings() }

    suspend fun update(transform: (AppSettings) -> AppSettings) {
        context.settingsStore.edit { prefs -> prefs.store(transform(prefs.toSettings())) }
    }
}

/**
 * Where each setting is kept: its key, and how to read it from and set it on [AppSettings]. A new
 * setting needs a line here as well as its field (SettingsStorageTest checks there's one per
 * field). Keys are what's on devices already; don't rename them.
 */
internal val STORED_SETTINGS: List<Stored> =
    listOf(
        stored(enumKey<ThemeChoice>("theme"), { theme }) { copy(theme = it) },
        stored(enumKey<ReaderFont>("font"), { font }) { copy(font = it) },
        stored(enumKey<TextSize>("text_size"), { textSize }) { copy(textSize = it) },
        stored(booleanPreferencesKey("justify"), { justify }) { copy(justify = it) },
        stored(booleanPreferencesKey("unread_only"), { unreadOnly }) { copy(unreadOnly = it) },
        stored(intPreferencesKey("retention_days"), { retentionDays }) {
            copy(retentionDays = it)
        },
        stored(stringSetPreferencesKey("expanded_tags"), { expandedTags }) {
            copy(expandedTags = it)
        },
        stored(booleanPreferencesKey("hide_empty_lists"), { hideEmptyLists }) {
            copy(hideEmptyLists = it)
        },
        storedOrNull(stringPreferencesKey("narration_voice"), { narrationVoice }) {
            copy(narrationVoice = it)
        },
        stored(floatPreferencesKey("narration_speed"), { narrationSpeed }) {
            copy(narrationSpeed = it)
        },
        stored(booleanPreferencesKey("narration_auto_scroll"), { narrationAutoScroll }) {
            copy(narrationAutoScroll = it)
        },
        stored(enumKey<NarrationEngine>("narration_engine"), { narrationEngine }) {
            copy(narrationEngine = it)
        },
        storedOrNull(stringPreferencesKey("cloud_voice_model"), { cloudVoiceModel }) {
            copy(cloudVoiceModel = it)
        },
        storedOrNull(stringPreferencesKey("cloud_voice"), { cloudVoice }) {
            copy(cloudVoice = it)
        },
    )

internal fun Preferences.toSettings(): AppSettings =
    STORED_SETTINGS.fold(AppSettings()) { settings, stored -> stored.read(this, settings) }

internal fun MutablePreferences.store(settings: AppSettings) {
    STORED_SETTINGS.forEach { it.write(this, settings) }
}

/** One setting's place in storage. */
internal class Stored
private constructor(
    private val key: Preferences.Key<Any>,
    private val get: AppSettings.() -> Any?,
    private val set: AppSettings.(Any?) -> AppSettings,
) {
    /** A missing or unreadable value leaves the default. */
    fun read(prefs: Preferences, settings: AppSettings): AppSettings =
        prefs[key]?.let { settings.set(it) } ?: settings

    fun write(prefs: MutablePreferences, settings: AppSettings) {
        settings.get()?.let { prefs[key] = it } ?: prefs.remove(key)
    }

    companion object {
        @Suppress("UNCHECKED_CAST")
        fun <T, S : Any> of(
            key: StoredKey<T, S>,
            get: AppSettings.() -> T?,
            set: AppSettings.(T) -> AppSettings,
        ): Stored =
            Stored(
                key.key as Preferences.Key<Any>,
                { get()?.let(key.toStored) },
                { stored -> key.fromStored(stored as S)?.let { set(it) } ?: this },
            )
    }
}

/** How a [T] is kept: under [key] as an [S]; [fromStored] is null for a value it can't read. */
internal class StoredKey<T, S : Any>(
    val key: Preferences.Key<S>,
    val toStored: (T) -> S,
    val fromStored: (S) -> T?,
)

private fun <T : Any> plain(key: Preferences.Key<T>) = StoredKey<T, T>(key, { it }, { it })

private inline fun <reified E : Enum<E>> enumKey(name: String) =
    StoredKey<E, String>(
        stringPreferencesKey(name),
        { it.name },
        { stored -> runCatching { enumValueOf<E>(stored) }.getOrNull() },
    )

private fun <T : Any> stored(
    key: Preferences.Key<T>,
    get: AppSettings.() -> T,
    set: AppSettings.(T) -> AppSettings,
) = Stored.of(plain(key), get, set)

private fun <T, S : Any> stored(
    key: StoredKey<T, S>,
    get: AppSettings.() -> T,
    set: AppSettings.(T) -> AppSettings,
) = Stored.of(key, get, set)

/** Null isn't stored (the key is removed), and reads back as null. */
private fun <T : Any> storedOrNull(
    key: Preferences.Key<T>,
    get: AppSettings.() -> T?,
    set: AppSettings.(T?) -> AppSettings,
) = Stored.of(plain(key), get) { set(it) }
