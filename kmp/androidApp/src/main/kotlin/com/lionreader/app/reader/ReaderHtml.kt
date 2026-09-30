package com.lionreader.app.reader

import android.content.Context
import com.lionreader.app.AppSettings
import com.lionreader.app.ReaderFont
import org.json.JSONObject

/** Per-font sizing shared with the web (`assets/reader/appearance.json`). */
class AppearanceTokens(private val json: JSONObject) {
    fun sizeAdjust(font: ReaderFont): Double =
        json.getJSONObject("fonts").getJSONObject(font.key).getDouble("sizeAdjust")

    fun lineHeight(font: ReaderFont): Double =
        json.getJSONObject("fonts").getJSONObject(font.key).getDouble("lineHeight")

    fun textSize(settings: AppSettings): Double =
        json.getJSONObject("textSizes").getDouble(settings.textSize.key)

    companion object {
        fun load(context: Context) =
            AppearanceTokens(
                JSONObject(
                    context.assets.open("reader/appearance.json").bufferedReader().use {
                        it.readText()
                    }
                )
            )
    }
}

data class ReaderColors(
    val text: String,
    val muted: String,
    val link: String,
    val background: String,
    val border: String,
    val codeBackground: String,
)

/** Where the bundled fonts and script are served from (see ReaderWebView's asset loader). */
const val ASSET_ORIGIN = "https://appassets.androidplatform.net"

/** The reader view's invariant is in SECURITY.md §1. */
private const val CONTENT_SECURITY_POLICY =
    "default-src 'none'; " +
        "script-src $ASSET_ORIGIN/assets/reader/scroll-detect.js; " +
        "base-uri 'none'; form-action 'none'; " +
        "style-src 'unsafe-inline'; font-src $ASSET_ORIGIN; " +
        "img-src * data:; media-src *; frame-src https:"

private val FONT_FILES =
    mapOf(
        "Merriweather" to "Merriweather",
        "Literata" to "Literata",
        "Inter" to "Inter",
        "Source Sans 3" to "SourceSans3",
    )

private val fontFaces: String =
    FONT_FILES.entries.joinToString("\n") { (family, file) ->
        """
        @font-face { font-family: '$family'; font-style: normal; font-weight: 300 800;
          src: url('$ASSET_ORIGIN/assets/reader/fonts/$file.woff2') format('woff2'); }
        @font-face { font-family: '$family'; font-style: italic; font-weight: 300 800;
          src: url('$ASSET_ORIGIN/assets/reader/fonts/$file-Italic.woff2') format('woff2'); }
        """
            .trimIndent()
    }

/** The article's title and byline, shown above the body. Plain text from the feed. */
data class ReaderHeader(val title: String, val byline: String)

/**
 * A complete document for the article: the [header], escaped, and the body. The body is the
 * server's sanitized HTML (sanitized on every read); it is inserted verbatim and never re-sanitized
 * here. Our script goes in the head, ahead of it, so no unclosed element in the body can swallow
 * it.
 */
fun readerDocument(
    header: ReaderHeader,
    body: String,
    settings: AppSettings,
    tokens: AppearanceTokens,
    colors: ReaderColors,
): String {
    val font = settings.font
    val size = tokens.textSize(settings) * tokens.sizeAdjust(font)
    return """
        <!DOCTYPE html>
        <html><head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta name="referrer" content="no-referrer">
        <meta http-equiv="Content-Security-Policy" content="$CONTENT_SECURITY_POLICY">
        <script defer src="$ASSET_ORIGIN/assets/reader/scroll-detect.js"></script>
        <style>
        $fontFaces
        html { background: ${colors.background}; }
        body {
          margin: 0 16px 48px; color: ${colors.text};
          font-family: ${font.cssFamily}; font-size: ${size}rem;
          line-height: ${tokens.lineHeight(font)};
          text-align: ${if (settings.justify) "justify" else "left"};
          overflow-wrap: break-word; hyphens: auto;
        }
        a { color: ${colors.link}; }
        h1, h2, h3, h4, h5, h6 { line-height: 1.3; margin: 1.5em 0 0.5em; text-align: left; }
        h1 { font-size: 1.6em; } h2 { font-size: 1.35em; } h3 { font-size: 1.15em; }
        p, ul, ol, blockquote, figure, pre, table, details { margin: 0 0 1.1em; }
        img, video, svg, iframe { max-width: 100%; height: auto; border-radius: 6px; }
        figure { margin-left: 0; margin-right: 0; }
        figcaption { color: ${colors.muted}; font-size: 0.875em; }
        blockquote { margin-left: 0; padding-left: 1em; border-left: 3px solid ${colors.border};
          color: ${colors.muted}; }
        pre { overflow-x: auto; padding: 0.75em; border-radius: 6px;
          background: ${colors.codeBackground}; font-size: 0.85em; line-height: 1.5; }
        code { font-size: 0.9em; }
        table { display: block; overflow-x: auto; border-collapse: collapse; }
        th, td { border: 1px solid ${colors.border}; padding: 0.3em 0.6em; }
        hr { border: 0; border-top: 1px solid ${colors.border}; }
        details { border: 1px solid ${colors.border}; border-radius: 6px; padding: 0.5em 0.75em; }
        math { font-size: 1.1em; }
        .lr-header { margin: 16px 0 1.5em; padding-bottom: 1em; text-align: left;
          border-bottom: 1px solid ${colors.border}; }
        .lr-header h1 { font-size: 1.5em; margin: 0 0 0.3em; }
        .lr-byline { margin: 0; color: ${colors.muted}; font-family: sans-serif;
          font-size: 0.875rem; line-height: 1.4; }
        .katex-mathml + .katex-html { display: none; }
        </style></head>
        <body>
        """
        .trimIndent() +
        // After trimIndent, so feed text can't change the template's indentation.
        "<header class=\"lr-header\"><h1>${escapeHtml(header.title)}</h1>" +
        "<p class=\"lr-byline\">${escapeHtml(header.byline)}</p></header>" +
        body +
        "</body></html>"
}

/** Feed text goes into the document only through here. */
internal fun escapeHtml(text: String): String =
    buildString(text.length) {
        for (c in text) {
            when (c) {
                '&' -> append("&amp;")
                '<' -> append("&lt;")
                '>' -> append("&gt;")
                '"' -> append("&quot;")
                '\'' -> append("&#39;")
                else -> append(c)
            }
        }
    }
