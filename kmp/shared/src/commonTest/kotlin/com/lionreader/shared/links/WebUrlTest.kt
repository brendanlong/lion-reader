package com.lionreader.shared.links

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class WebUrlTest {
    @Test
    fun onlyWebAddressesAreOpened() {
        assertEquals("https://example.com/a", webUrl(" https://example.com/a "))
        assertEquals("HTTP://example.com", webUrl("HTTP://example.com"))
        listOf(
                null,
                "",
                "javascript:alert(1)",
                "intent://scan/#Intent;scheme=zxing;end",
                "file:///data/data/com.lionreader.app/shared_prefs/auth.xml",
                "content://settings/secure",
                "example.com",
            )
            .forEach { assertNull(webUrl(it), it) }
    }
}
