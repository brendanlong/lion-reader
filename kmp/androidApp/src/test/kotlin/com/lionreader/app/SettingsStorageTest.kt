package com.lionreader.app

import androidx.datastore.preferences.core.mutablePreferencesOf
import androidx.datastore.preferences.core.stringPreferencesKey
import java.lang.reflect.Modifier
import org.junit.Assert.assertEquals
import org.junit.Test

class SettingsStorageTest {
    /** Every field changed from its default. */
    private val changed =
        AppSettings(
            theme = ThemeChoice.BLACK,
            font = ReaderFont.LITERATA,
            textSize = TextSize.LARGE,
            justify = true,
            unreadOnly = false,
            retentionDays = 7,
            expandedTags = setOf("tag"),
            hideEmptyLists = true,
            narrationVoice = "voice",
            narrationSpeed = 1.5f,
            narrationAutoScroll = false,
            narrationEngine = NarrationEngine.CLOUD,
            cloudVoiceModel = "deepinfra:hexgrad/Kokoro-82M",
            cloudVoice = "af_heart",
        )

    @Test
    fun everySettingIsStored() {
        val fields =
            AppSettings::class.java.declaredFields.count { !Modifier.isStatic(it.modifiers) }
        assertEquals("a STORED_SETTINGS line per AppSettings field", fields, STORED_SETTINGS.size)
        // And the test's own list changes them all.
        AppSettings::class
            .java
            .declaredFields
            .filter { !Modifier.isStatic(it.modifiers) }
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
                "retention_days",
                "expanded_tags",
                "hide_empty_lists",
                "narration_voice",
                "narration_speed",
                "narration_auto_scroll",
                "narration_engine",
                "cloud_voice_model",
                "cloud_voice",
            ),
            keys,
        )
    }
}
