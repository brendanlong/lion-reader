package com.lionreader.app

import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.mutablePreferencesOf
import androidx.datastore.preferences.core.stringPreferencesKey
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class EinkDeviceTest {
    @Test
    fun knowsEreaderMakersByManufacturerOrBrand() {
        assertTrue(isEinkDevice("ONYX", "Onyx"))
        assertTrue(isEinkDevice("Qualcomm", "BOOX"))
        assertTrue(isEinkDevice("Bigme", "bigme"))
        assertFalse(isEinkDevice("Google", "google"))
        assertFalse(isEinkDevice("", ""))
    }

    @Test
    fun anEinkDeviceStartsOnEpaperWithoutAnimationsButKeepsWhatTheUserChose() {
        val defaults = deviceDefaults(eink = true)
        val unchanged = mutablePreferencesOf()
        assertEquals(ThemeChoice.EPAPER, unchanged.toSettings(defaults).theme)
        assertFalse(unchanged.toSettings(defaults).animations)

        // A theme picked on the device; animations stay off unless turned on too.
        val themed = mutablePreferencesOf(stringPreferencesKey("theme") to "DARK")
        assertEquals(ThemeChoice.DARK, themed.toSettings(defaults).theme)
        assertFalse(themed.toSettings(defaults).animations)
        themed[booleanPreferencesKey("animations")] = true
        assertTrue(themed.toSettings(defaults).animations)
    }

    @Test
    fun otherDevicesStartWithTheUsualDefaults() {
        assertEquals(AppSettings(), deviceDefaults(eink = false))
    }
}
