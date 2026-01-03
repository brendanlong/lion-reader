package com.lionreader.ui.narration

import org.jsoup.Jsoup
import org.jsoup.nodes.Element
import org.jsoup.nodes.TextNode

/**
 * Converts HTML content to a list of speakable paragraphs for narration.
 *
 * Block elements (p, h1-h6, blockquote, pre, li, figure, table) become
 * separate paragraphs. Special content is converted to spoken descriptions:
 * - Headings: Prefixed with "Heading:" or "Subheading:"
 * - Images: "Image: alt text" or "Image"
 * - Code blocks: "Code block: ... End code block."
 * - Blockquotes: "Quote: ... End quote."
 * - Tables: "Table: row1. row2. End table."
 */
object HtmlToTextConverter {
    private val BLOCK_ELEMENTS =
        setOf(
            "p",
            "h1",
            "h2",
            "h3",
            "h4",
            "h5",
            "h6",
            "blockquote",
            "pre",
            "li",
            "figure",
            "table",
        )

    /**
     * Converts HTML to a list of speakable paragraphs.
     *
     * @param html The HTML content to convert
     * @return List of paragraph strings, one per block element. Empty paragraphs are filtered out.
     */
    fun convert(html: String): List<String> {
        if (html.isBlank()) return emptyList()

        val doc = Jsoup.parse(html)
        val paragraphs = mutableListOf<String>()

        // Process block elements in document order
        for (element in doc.body().select(BLOCK_ELEMENTS.joinToString(", "))) {
            // Skip nested block elements (already processed by parent)
            if (element.parents().any { it.tagName() in BLOCK_ELEMENTS }) continue

            val text = processElement(element)
            if (text.isNotBlank()) {
                paragraphs.add(text.trim())
            }
        }

        return paragraphs
    }

    private fun processElement(el: Element): String =
        when (el.tagName()) {
            "h1", "h2" -> "Heading: ${el.text()}"
            "h3", "h4", "h5", "h6" -> "Subheading: ${el.text()}"
            "pre" -> "Code block: ${el.text()}. End code block."
            "blockquote" -> "Quote: ${el.text().trimEnd('.')}. End quote."
            "figure" -> {
                val alt =
                    el.selectFirst("img")?.attr("alt")?.takeIf { it.isNotBlank() }
                        ?: el.selectFirst("figcaption")?.text()
                if (alt.isNullOrBlank()) "Image" else "Image: $alt"
            }
            "table" -> {
                val rows =
                    el.select("tr").map { row ->
                        row.select("th, td").joinToString(", ") { it.text() }
                    }
                "Table: ${rows.joinToString(". ")}. End table."
            }
            else -> processInlineContent(el)
        }

    private fun processInlineContent(el: Element): String {
        // Replace inline images with spoken description
        el.select("img").forEach { img ->
            val alt = img.attr("alt").ifBlank { "image" }
            img.replaceWith(TextNode("[Image: $alt]"))
        }
        return el.text()
    }
}
