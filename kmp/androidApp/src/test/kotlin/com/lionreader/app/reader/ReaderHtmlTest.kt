package com.lionreader.app.reader

import com.lionreader.app.AppSettings
import com.lionreader.app.ReaderFont
import com.lionreader.app.TextSize
import org.json.JSONObject
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
// The real Application schedules WorkManager, which these tests don\'t need.
@Config(application = android.app.Application::class)
class ReaderHtmlTest {
    private val tokens =
        AppearanceTokens(
            JSONObject(
                """{"fonts":{"system":{"sizeAdjust":1,"lineHeight":1.7},
                "merriweather":{"sizeAdjust":0.929,"lineHeight":1.8},
                "literata":{"sizeAdjust":1,"lineHeight":1.75},
                "inter":{"sizeAdjust":0.945,"lineHeight":1.7},
                "source-sans":{"sizeAdjust":1.061,"lineHeight":1.7}},
                "textSizes":{"small":0.875,"medium":1,"large":1.125,"x-large":1.25}}"""
            )
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
            )
        assertTrue(html.contains("&lt;img src=x onerror=alert(1)&gt; &amp; &quot;quotes&quot;"))
        assertTrue(html.contains("&lt;script&gt;alert(1)&lt;/script&gt; · O&#39;Brien"))
        assertFalse(html.contains("<img"))
        assertFalse(html.contains("<script>alert"))
    }

    @Test
    fun bodyIsInsertedVerbatim() {
        val body = "<pre>\n        indented code\n</pre>"
        val html = readerDocument(header, null, body, AppSettings(), tokens, colors)
        assertTrue(html.contains(body))
    }

    @Test
    fun summaryGoesVerbatimBetweenTheHeaderAndTheBody() {
        val summary = "<ul><li>Point one</li></ul>"
        val html = readerDocument(header, summary, "<p>Body</p>", AppSettings(), tokens, colors)
        val headerEnd = html.indexOf("</header>")
        val summaryAt = html.indexOf(summary)
        assertTrue(headerEnd in 0 until summaryAt)
        assertTrue(summaryAt < html.indexOf("<p>Body</p>"))
    }

    @Test
    fun sizeCombinesTextSizeAndFontAdjustment() {
        val settings = AppSettings(font = ReaderFont.MERRIWEATHER, textSize = TextSize.LARGE)
        val html = readerDocument(header, null, "", settings, tokens, colors)
        assertTrue(html.contains("font-size: ${1.125 * 0.929}rem"))
        assertTrue(html.contains("line-height: 1.8"))
    }
}
