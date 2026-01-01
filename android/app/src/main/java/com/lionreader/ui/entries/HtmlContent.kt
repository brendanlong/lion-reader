package com.lionreader.ui.entries

import android.annotation.SuppressLint
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView

/**
 * Composable for rendering HTML content using a WebView.
 *
 * Provides styled HTML rendering with support for:
 * - Dark mode styling (automatically adapts to system theme)
 * - Responsive images (max-width: 100%)
 * - Link handling (opens in external browser via WebViewClient)
 * - Security (JavaScript disabled)
 *
 * @param html The HTML content to render
 * @param onLinkClick Callback when a link is clicked in the content
 * @param baseUrl Optional base URL for resolving relative URLs in the content (e.g., image src)
 * @param modifier Modifier for the WebView container
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun HtmlContent(
    html: String,
    onLinkClick: (String) -> Unit,
    baseUrl: String? = null,
    modifier: Modifier = Modifier,
) {
    val isDarkTheme = isSystemInDarkTheme()

    // Generate styled HTML with theme-appropriate colors
    val styledHtml =
        remember(html, isDarkTheme) {
            generateStyledHtml(html, isDarkTheme)
        }

    AndroidView(
        factory = { context ->
            WebView(context).apply {
                // Security: Disable JavaScript
                settings.javaScriptEnabled = false

                // Layout settings for responsive content
                settings.loadWithOverviewMode = true
                settings.useWideViewPort = true

                // Disable scrollbars (parent handles scrolling)
                isVerticalScrollBarEnabled = false
                isHorizontalScrollBarEnabled = false

                // Handle link clicks
                webViewClient =
                    object : WebViewClient() {
                        @Deprecated("Deprecated in API 24, but we need to support API 26+")
                        override fun shouldOverrideUrlLoading(
                            view: WebView?,
                            url: String?,
                        ): Boolean {
                            url?.let { onLinkClick(it) }
                            return true // Prevent WebView from loading the URL
                        }

                        override fun shouldOverrideUrlLoading(
                            view: WebView?,
                            request: WebResourceRequest?,
                        ): Boolean {
                            request?.url?.toString()?.let { onLinkClick(it) }
                            return true // Prevent WebView from loading the URL
                        }
                    }

                // Set background to transparent to match theme
                setBackgroundColor(android.graphics.Color.TRANSPARENT)
            }
        },
        update = { webView ->
            webView.loadDataWithBaseURL(
                baseUrl,
                styledHtml,
                "text/html",
                "UTF-8",
                null,
            )
        },
        modifier = modifier,
    )
}

/**
 * Generates styled HTML with CSS for consistent rendering.
 *
 * Applies responsive styling, typography, and theme-appropriate colors.
 *
 * @param html The raw HTML content
 * @param isDarkTheme Whether dark theme is active
 * @return Complete HTML document with embedded CSS
 */
private fun generateStyledHtml(
    html: String,
    isDarkTheme: Boolean,
): String {
    // Theme-specific colors
    val textColor = if (isDarkTheme) "#F9FAFB" else "#1F2937"
    val backgroundColor = if (isDarkTheme) "#1F2937" else "#FFFFFF"
    val linkColor = if (isDarkTheme) "#FCD34D" else "#D97706"
    val codeBackground = if (isDarkTheme) "#374151" else "#F3F4F6"
    val blockquoteBorder = if (isDarkTheme) "#4B5563" else "#D1D5DB"
    val blockquoteText = if (isDarkTheme) "#9CA3AF" else "#6B7280"

    return """
        <!DOCTYPE html>
        <html>
        <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
            <meta charset="UTF-8">
            <style>
                * {
                    box-sizing: border-box;
                }

                html, body {
                    margin: 0;
                    padding: 0;
                    background-color: $backgroundColor;
                }

                body {
                    font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
                    font-size: 16px;
                    line-height: 1.7;
                    color: $textColor;
                    word-wrap: break-word;
                    overflow-wrap: break-word;
                    -webkit-text-size-adjust: 100%;
                }

                /* Typography */
                h1, h2, h3, h4, h5, h6 {
                    margin-top: 1.5em;
                    margin-bottom: 0.5em;
                    font-weight: 600;
                    line-height: 1.3;
                }

                h1 { font-size: 1.75em; }
                h2 { font-size: 1.5em; }
                h3 { font-size: 1.25em; }
                h4 { font-size: 1.1em; }
                h5, h6 { font-size: 1em; }

                p {
                    margin: 0 0 1em 0;
                }

                /* Links */
                a {
                    color: $linkColor;
                    text-decoration: underline;
                    text-underline-offset: 2px;
                }

                a:visited {
                    color: $linkColor;
                }

                /* Images */
                img {
                    max-width: 100%;
                    height: auto;
                    display: block;
                    margin: 1em auto;
                    border-radius: 8px;
                }

                figure {
                    margin: 1em 0;
                    padding: 0;
                }

                figcaption {
                    font-size: 0.875em;
                    color: $blockquoteText;
                    text-align: center;
                    margin-top: 0.5em;
                }

                /* Code blocks */
                pre, code {
                    font-family: 'SF Mono', Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
                    font-size: 0.875em;
                }

                code {
                    background: $codeBackground;
                    padding: 0.2em 0.4em;
                    border-radius: 4px;
                }

                pre {
                    background: $codeBackground;
                    padding: 1em;
                    border-radius: 8px;
                    overflow-x: auto;
                    -webkit-overflow-scrolling: touch;
                }

                pre code {
                    background: transparent;
                    padding: 0;
                    border-radius: 0;
                }

                /* Blockquotes */
                blockquote {
                    margin: 1em 0;
                    padding: 0.5em 0 0.5em 1em;
                    border-left: 4px solid $blockquoteBorder;
                    color: $blockquoteText;
                    font-style: italic;
                }

                blockquote p:last-child {
                    margin-bottom: 0;
                }

                /* Lists */
                ul, ol {
                    margin: 1em 0;
                    padding-left: 2em;
                }

                li {
                    margin: 0.5em 0;
                }

                /* Tables */
                table {
                    width: 100%;
                    border-collapse: collapse;
                    margin: 1em 0;
                    overflow-x: auto;
                    display: block;
                }

                th, td {
                    border: 1px solid $blockquoteBorder;
                    padding: 0.5em;
                    text-align: left;
                }

                th {
                    background: $codeBackground;
                    font-weight: 600;
                }

                /* Horizontal rules */
                hr {
                    border: none;
                    border-top: 1px solid $blockquoteBorder;
                    margin: 2em 0;
                }

                /* Videos and embeds */
                video, iframe {
                    max-width: 100%;
                    border-radius: 8px;
                }

                /* Prevent text from being too wide */
                .content-wrapper {
                    max-width: 100%;
                }
            </style>
        </head>
        <body>
            <div class="content-wrapper">
                $html
            </div>
        </body>
        </html>
        """.trimIndent()
}
