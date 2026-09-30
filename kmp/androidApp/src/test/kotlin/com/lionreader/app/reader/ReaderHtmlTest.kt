package com.lionreader.app.reader

import com.lionreader.app.AppSettings
import com.lionreader.app.ReaderFont
import com.lionreader.app.TextSize
import org.json.JSONObject
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

    @Test
    fun bodyIsInsertedVerbatim() {
        val body = "<pre>\n        indented code\n</pre>"
        val html = readerDocument(body, AppSettings(), tokens, colors)
        assertTrue(html.contains(body))
    }

    @Test
    fun sizeCombinesTextSizeAndFontAdjustment() {
        val settings = AppSettings(font = ReaderFont.MERRIWEATHER, textSize = TextSize.LARGE)
        val html = readerDocument("", settings, tokens, colors)
        assertTrue(html.contains("font-size: ${1.125 * 0.929}rem"))
        assertTrue(html.contains("line-height: 1.8"))
    }
}
