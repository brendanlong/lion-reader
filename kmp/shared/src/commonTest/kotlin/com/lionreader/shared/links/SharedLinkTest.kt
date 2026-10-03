package com.lionreader.shared.links

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class SharedLinkTest {
    @Test
    fun aBareLink() {
        assertEquals("https://example.com/a?b=c#d", sharedLink("https://example.com/a?b=c#d"))
    }

    @Test
    fun aLinkAfterItsTitle() {
        assertEquals(
            "https://example.com/post",
            sharedLink("A great post\nhttps://example.com/post"),
        )
    }

    @Test
    fun surroundingPunctuationIsNotPartOfIt() {
        assertEquals("https://example.com/x", sharedLink("Read this (https://example.com/x)."))
        assertEquals("https://example.com/x", sharedLink("\"https://example.com/x\","))
    }

    @Test
    fun parenthesesTheLinkOpenedStay() {
        assertEquals(
            "https://en.wikipedia.org/wiki/Lion_(disambiguation)",
            sharedLink("See https://en.wikipedia.org/wiki/Lion_(disambiguation)."),
        )
    }

    @Test
    fun textWithoutALink() {
        assertNull(sharedLink("just some words"))
        assertNull(sharedLink("ftp://example.com/file"))
        assertNull(sharedLink(null))
    }
}
