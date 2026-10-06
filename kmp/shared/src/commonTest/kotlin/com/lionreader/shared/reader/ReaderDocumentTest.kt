package com.lionreader.shared.reader

import com.lionreader.shared.settings.AppSettings
import com.lionreader.shared.settings.ReaderFont
import com.lionreader.shared.settings.TextSize
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ReaderDocumentTest {
    private val tokens =
        AppearanceTokens.parse(
            """{"fonts":{"system":{"sizeAdjust":1,"lineHeight":1.7},
                "merriweather":{"sizeAdjust":0.929,"lineHeight":1.8},
                "literata":{"sizeAdjust":1,"lineHeight":1.75},
                "inter":{"sizeAdjust":0.945,"lineHeight":1.7},
                "source-sans":{"sizeAdjust":1.061,"lineHeight":1.7}},
                "textSizes":{"small":0.875,"medium":1,"large":1.125,"x-large":1.25}}"""
        )
    private val colors = ReaderColors("#000", "#666", "#b45309", "#fff", "#ccc", "#eee")
    private val header = ReaderHeader("Title", "Feed · Sep 29, 2026")

    @Test
    fun headerTextIsEscaped() {
        val html =
            readerDocument(
                ReaderHeader(
                    title = "<img src=x onerror=alert(1)> & \"quotes\"",
                    byline = "<script>alert(1)</script> · O'Brien",
                ),
                null,
                "",
                AppSettings(),
                tokens,
                colors,
                ORIGIN,
            )
        assertTrue(html.contains("&lt;img src=x onerror=alert(1)&gt; &amp; &quot;quotes&quot;"))
        assertTrue(html.contains("&lt;script&gt;alert(1)&lt;/script&gt; · O&#39;Brien"))
        assertFalse(html.contains("<img"))
        assertFalse(html.contains("<script>alert"))
    }

    @Test
    fun theTitleLinksToAWebAddressOnly() {
        fun titleOf(url: String?) =
            readerDocument(
                    ReaderHeader("Title", "Feed", url),
                    null,
                    "",
                    AppSettings(),
                    tokens,
                    colors,
                    ORIGIN,
                )
                .substringAfter("<h1>")
                .substringBefore("</h1>")

        assertEquals(
            "<a href=\"https://example.com/a?b=1&amp;c=&quot;2&quot;\">Title</a>",
            titleOf("https://example.com/a?b=1&c=\"2\""),
        )
        assertEquals("Title", titleOf("javascript:alert(1)"))
        assertEquals("Title", titleOf(null))
    }

    @Test
    fun bodyIsInsertedVerbatim() {
        val body = "<pre>\n        indented code\n</pre>"
        val html = readerDocument(header, null, body, AppSettings(), tokens, colors, ORIGIN)
        assertTrue(html.contains(body))
    }

    @Test
    fun summaryGoesVerbatimBetweenTheHeaderAndTheBody() {
        val summary = "<ul><li>Point one</li></ul>"
        val html =
            readerDocument(header, summary, "<p>Body</p>", AppSettings(), tokens, colors, ORIGIN)
        val headerEnd = html.indexOf("</header>")
        val summaryAt = html.indexOf(summary)
        assertTrue(headerEnd in 0 until summaryAt)
        assertTrue(summaryAt < html.indexOf("<p>Body</p>"))
    }

    @Test
    fun sizeCombinesTextSizeAndFontAdjustment() {
        val settings = AppSettings(font = ReaderFont.MERRIWEATHER, textSize = TextSize.LARGE)
        val html = readerDocument(header, null, "", settings, tokens, colors, ORIGIN)
        assertTrue(html.contains("font-size: ${1.125 * 0.929}rem"))
        assertTrue(html.contains("line-height: 1.8"))
    }

    @Test
    fun theScriptsComeOnlyFromTheAssetOrigin() {
        val html = readerDocument(header, null, "", AppSettings(), tokens, colors, ORIGIN)
        val csp = html.substringAfter("Content-Security-Policy\" content=\"").substringBefore('"')
        assertTrue(csp.startsWith("default-src 'none'; "))
        assertTrue(
            "script-src $ORIGIN/assets/reader/scroll-detect.js $ORIGIN/assets/reader/narration.js;" in
                csp
        )
    }

    @Test
    fun linksOutsideTheArticleAreWebPagesNotTheReadersOwn() {
        assertEquals("https://example.com/a", linkTarget(" https://example.com/a ", ORIGIN))
        assertEquals("http://example.com/", linkTarget("http://example.com/", ORIGIN))
        assertNull(linkTarget("mailto:someone@example.com", ORIGIN))
        assertNull(linkTarget("javascript:alert(1)", ORIGIN))
        // A relative link, resolved against the reader's own origin.
        assertNull(linkTarget("$ORIGIN/notes#1", ORIGIN))
        assertNull(linkTarget(ORIGIN, ORIGIN))
        assertNull(linkTarget("HTTPS://APPASSETS.EXAMPLE/notes", ORIGIN))
        assertNull(linkTarget(null, ORIGIN))
    }

    private companion object {
        const val ORIGIN = "https://appassets.example"
    }
}
