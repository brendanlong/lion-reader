package com.lionreader.app

import com.lionreader.shared.settings.AppSettings
import com.lionreader.shared.settings.ThemeChoice
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
    fun anEinkDeviceStartsOnEpaperWithoutAnimations() {
        assertEquals(
            AppSettings(theme = ThemeChoice.EPAPER, animations = false),
            deviceDefaults(eink = true),
        )
    }

    @Test
    fun otherDevicesStartWithTheUsualDefaults() {
        assertEquals(AppSettings(), deviceDefaults(eink = false))
    }
}
