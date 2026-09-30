package com.lionreader.app

import android.content.Context
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
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
        )
    }
}

private inline fun <reified T : Enum<T>> enumOr(name: String?, default: T): T =
    name?.let { runCatching { enumValueOf<T>(it) }.getOrNull() } ?: default
