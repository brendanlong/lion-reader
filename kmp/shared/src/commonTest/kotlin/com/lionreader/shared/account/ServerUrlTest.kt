package com.lionreader.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ServerUrlTest {
    private fun valid(input: String, allowHttp: Boolean = false): String? =
        (parseServerUrl(input, allowHttp) as? ServerUrlInput.Valid)?.url

    @Test
    fun anAddressWithoutASchemeIsHttps() {
        assertEquals("https://lionreader.com", valid("lionreader.com"))
        assertEquals("https://reader.example:8443", valid(" reader.example:8443/ "))
    }

    @Test
    fun theAddressComesBackInOneForm() {
        assertEquals("https://lionreader.com", valid("https://lionreader.com"))
        assertEquals("https://lionreader.com", valid("HTTPS://LionReader.com/"))
        assertEquals("https://lionreader.com", valid("https://lionreader.com:443"))
        assertEquals("http://localhost:42873", valid("http://localhost:42873", allowHttp = true))
    }

    @Test
    fun anInternationalizedHostIsInPunycode() {
        assertEquals("https://xn--bcher-kva.example", valid("Bücher.example"))
        assertEquals("https://xn--bcher-kva.example:8443", valid("https://bücher.example:8443/"))
    }

    @Test
    fun plainHttpOnlyWhereAllowed() {
        assertTrue(parseServerUrl("http://localhost:3000", false) is ServerUrlInput.Invalid)
        assertEquals("http://localhost:3000", valid("http://localhost:3000", allowHttp = true))
    }

    @Test
    fun anythingButAWebServersAddressIsRefused() {
        listOf(
                "",
                "   ",
                "ftp://lionreader.com",
                "javascript:alert(1)",
                "https://",
                "https://user@lionreader.com",
                "https://lionreader.com/app",
                "https://lionreader.com?x=1",
                "https://lionreader.com#top",
                "https://lion reader.com",
                "lionreader.com:port",
            )
            .forEach { input ->
                assertTrue(input, parseServerUrl(input, allowHttp = true) is ServerUrlInput.Invalid)
            }
    }
}
