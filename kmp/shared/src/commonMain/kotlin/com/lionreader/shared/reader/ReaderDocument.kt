package com.lionreader.shared.reader

import com.lionreader.shared.links.webUrl
import com.lionreader.shared.settings.AppSettings
import com.lionreader.shared.settings.ReaderFont
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** Per-font sizing shared with the web: the app's `assets/reader/appearance.json`, [parse]d. */
@Serializable
class AppearanceTokens(
    private val fonts: Map<String, FontTokens>,
    private val textSizes: Map<String, Double>,
) {
    @Serializable class FontTokens(val sizeAdjust: Double, val lineHeight: Double)

    fun sizeAdjust(font: ReaderFont): Double = fonts.getValue(font.key).sizeAdjust

    fun lineHeight(font: ReaderFont): Double = fonts.getValue(font.key).lineHeight

    fun textSize(settings: AppSettings): Double = textSizes.getValue(settings.textSize.key)

    companion object {
        private val json = Json { ignoreUnknownKeys = true }

        fun parse(text: String): AppearanceTokens = json.decodeFromString(serializer(), text)
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

/**
 * The reader view's invariant is in SECURITY.md §1. [assetOrigin]: where the app serves the bundled
 * fonts and scripts from (`<origin>/assets/reader/…`), and the document's own origin.
 */
private fun contentSecurityPolicy(assetOrigin: String) =
    "default-src 'none'; " +
        "script-src $assetOrigin/assets/reader/scroll-detect.js " +
        "$assetOrigin/assets/reader/reading-position.js " +
        "$assetOrigin/assets/reader/narration.js; " +
        "base-uri 'none'; form-action 'none'; " +
        "style-src 'unsafe-inline'; font-src $assetOrigin; " +
        "img-src * data:; media-src *; frame-src https:"

private val FONT_FILES =
    mapOf(
        "Merriweather" to "Merriweather",
        "Literata" to "Literata",
        "Inter" to "Inter",
        "Source Sans 3" to "SourceSans3",
    )

private fun fontFaces(assetOrigin: String): String =
    FONT_FILES.entries.joinToString("\n") { (family, file) ->
        """
        @font-face { font-family: '$family'; font-style: normal; font-weight: 300 800;
          src: url('$assetOrigin/assets/reader/fonts/$file.woff2') format('woff2'); }
        @font-face { font-family: '$family'; font-style: italic; font-weight: 300 800;
          src: url('$assetOrigin/assets/reader/fonts/$file-Italic.woff2') format('woff2'); }
        """
            .trimIndent()
    }

/**
 * The article's title and byline, shown above the body. Plain text from the feed; the title links
 * to [url] (the original) when that's a web address.
 */
data class ReaderHeader(val title: String, val byline: String, val url: String? = null)

/**
 * A complete document for the article: the [header], escaped, the AI [summary] if shown, and the
 * body. The summary and body are the server's sanitized HTML (sanitized on every read); they are
 * inserted verbatim and never re-sanitized here. Our script goes in the head, ahead of it, so no
 * unclosed element in the body can swallow it. The document is loaded at [assetOrigin], where the
 * app serves its bundled fonts and scripts.
 */
fun readerDocument(
    header: ReaderHeader,
    summary: String?,
    body: String,
    settings: AppSettings,
    tokens: AppearanceTokens,
    colors: ReaderColors,
    assetOrigin: String,
): String {
    val font = settings.font
    val size = tokens.textSize(settings) * tokens.sizeAdjust(font)
    return """
        <!DOCTYPE html>
        <html><head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta name="referrer" content="no-referrer">
        <meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(assetOrigin)}">
        <script defer src="$assetOrigin/assets/reader/scroll-detect.js"></script>
        <script defer src="$assetOrigin/assets/reader/reading-position.js"></script>
        <script defer src="$assetOrigin/assets/reader/narration.js"></script>
        <style>
        ${fontFaces(assetOrigin)}
        html { background: ${colors.background}; }
        body {
          /* A readable line on wide screens, as on the web (max-w-3xl). */
          max-width: 48rem; margin: 0 auto 48px; padding: 0 16px; color: ${colors.text};
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
        .lr-header h1 a { color: inherit; text-decoration: none; }
        .lr-byline { margin: 0; color: ${colors.muted}; font-family: sans-serif;
          font-size: 0.875rem; line-height: 1.4; }
        .lr-summary { margin: 0 0 1.5em; padding: 0.75em 1em; border-radius: 8px;
          border: 1px solid ${colors.border}; background: ${colors.codeBackground}; }
        .lr-summary > :last-child { margin-bottom: 0; }
        .lr-narrating { background: color-mix(in srgb, ${colors.link} 18%, transparent);
          border-radius: 4px; box-shadow: 0 0 0 4px color-mix(in srgb, ${colors.link} 18%, transparent); }
        .lr-summary-label { margin: 0 0 0.5em; color: ${colors.muted}; font-family: sans-serif;
          font-size: 0.875rem; font-weight: 600; }
        .katex-mathml + .katex-html { display: none; }
        </style></head>
        <body>
        """
        .trimIndent() +
        // After trimIndent, so feed text can't change the template's indentation.
        "<header class=\"lr-header\"><h1>" +
        (webUrl(header.url)?.let { "<a href=\"${escapeHtml(it)}\">${escapeHtml(header.title)}</a>" }
            ?: escapeHtml(header.title)) +
        "</h1>" +
        "<p class=\"lr-byline\">${escapeHtml(header.byline)}</p></header>" +
        (summary?.let {
            "<aside class=\"lr-summary\"><p class=\"lr-summary-label\">AI Summary</p>$it</aside>"
        } ?: "") +
        body +
        "</body></html>"
}

/**
 * [href] if it's a web page outside the article: not the reader's own [assetOrigin], which a
 * relative link resolves to.
 */
fun linkTarget(href: String?, assetOrigin: String): String? =
    webUrl(href)?.takeUnless {
        it.startsWith("$assetOrigin/", ignoreCase = true) ||
            it.equals(assetOrigin, ignoreCase = true)
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
