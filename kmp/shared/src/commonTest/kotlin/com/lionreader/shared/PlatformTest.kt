package com.lionreader.shared

import kotlin.test.Test
import kotlin.test.assertTrue

class PlatformTest {
    @Test
    fun greetingNamesThePlatform() {
        assertTrue(greeting().endsWith(platformName()))
    }
}
