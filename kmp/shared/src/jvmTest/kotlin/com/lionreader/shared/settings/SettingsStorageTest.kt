package com.lionreader.shared.settings

import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.floatPreferencesKey
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.mutablePreferencesOf
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.core.stringSetPreferencesKey
import java.lang.reflect.Modifier
import kotlin.test.Test
import kotlin.test.assertEquals

class SettingsStorageTest {
    /** Every field changed from its default. */
    private val changed =
        AppSettings(
            theme = ThemeChoice.BLACK,
            font = ReaderFont.LITERATA,
            textSize = TextSize.LARGE,
            justify = true,
            unreadOnly = false,
            oldestFirst = true,
            retentionDays = 7,
            expandedTags = setOf("tag"),
            hideEmptyLists = true,
            animations = false,
            pageScrolling = true,
            volumeKeyPaging = true,
            narrationVoice = "voice",
            narrationSpeed = 1.5f,
            narrationAutoScroll = false,
            narrationEngine = NarrationEngine.CLOUD,
            cloudVoiceModel = "deepinfra:hexgrad/Kokoro-82M",
            cloudVoice = "af_heart",
            cloudVoicePauseSeconds = 0.5f,
        )

    @Test
    fun everySettingIsStored() {
        val fields =
            AppSettings::class.java.declaredFields.count {
                !Modifier.isStatic(it.modifiers) && !it.isSynthetic
            }
        assertEquals(fields, STORED_SETTINGS.size, "a STORED_SETTINGS line per AppSettings field")
        // And the test's own list changes them all.
        AppSettings::class
            .java
            .declaredFields
            .filter { !Modifier.isStatic(it.modifiers) && !it.isSynthetic }
            .forEach { field ->
                field.isAccessible = true
                check(field.get(changed) != field.get(AppSettings())) { "${field.name} unchanged" }
            }
    }

    @Test
    fun settingsReadBackAsStored() {
        val prefs = mutablePreferencesOf()
        prefs.store(changed)
        assertEquals(changed, prefs.toSettings())

        prefs.store(AppSettings())
        assertEquals(AppSettings(), prefs.toSettings())
    }

    /** As settings were stored before (and are on devices): these types, these names. */
    @Test
    fun readsWhatsAlreadyOnDevices() {
        val prefs =
            mutablePreferencesOf(
                stringPreferencesKey("theme") to "BLACK",
                stringPreferencesKey("text_size") to "LARGE",
                booleanPreferencesKey("justify") to true,
                intPreferencesKey("retention_days") to 7,
                stringSetPreferencesKey("expanded_tags") to setOf("tag"),
                floatPreferencesKey("narration_speed") to 1.5f,
                stringPreferencesKey("narration_engine") to "CLOUD",
                stringPreferencesKey("cloud_voice") to "af_heart",
            )
        assertEquals(
            AppSettings(
                theme = ThemeChoice.BLACK,
                textSize = TextSize.LARGE,
                justify = true,
                retentionDays = 7,
                expandedTags = setOf("tag"),
                narrationSpeed = 1.5f,
                narrationEngine = NarrationEngine.CLOUD,
                cloudVoice = "af_heart",
            ),
            prefs.toSettings(),
        )
    }

    @Test
    fun anUnknownChoiceReadsAsTheDefault() {
        val prefs = mutablePreferencesOf(stringPreferencesKey("theme") to "SEPIA")
        assertEquals(AppSettings().theme, prefs.toSettings().theme)
    }

    @Test
    fun storedValuesKeepTheirKeys() {
        val prefs = mutablePreferencesOf()
        prefs.store(changed)
        val keys = prefs.asMap().keys.map { it.name }.toSet()
        assertEquals(
            setOf(
                "theme",
                "font",
                "text_size",
                "justify",
                "unread_only",
                "oldest_first",
                "retention_days",
                "expanded_tags",
                "hide_empty_lists",
                "animations",
                "page_scrolling",
                "volume_key_paging",
                "narration_voice",
                "narration_speed",
                "narration_auto_scroll",
                "narration_engine",
                "cloud_voice_model",
                "cloud_voice",
                "cloud_voice_pause_seconds",
            ),
            keys,
        )
    }

    /** The device's defaults (an e-reader's) hold until the user changes that setting. */
    @Test
    fun whatTheUserHasntChangedIsTheDevicesDefault() {
        val defaults = AppSettings(theme = ThemeChoice.EPAPER, animations = false)
        val unchanged = mutablePreferencesOf()
        assertEquals(defaults, unchanged.toSettings(defaults))

        val themed = mutablePreferencesOf(stringPreferencesKey("theme") to "DARK")
        assertEquals(ThemeChoice.DARK, themed.toSettings(defaults).theme)
        assertEquals(false, themed.toSettings(defaults).animations)
        themed[booleanPreferencesKey("animations")] = true
        assertEquals(true, themed.toSettings(defaults).animations)
    }
}
