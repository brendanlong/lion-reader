package com.lionreader.ui.narration

import com.lionreader.data.api.models.ParagraphMapEntry
import org.jsoup.Jsoup
import org.jsoup.nodes.Element
import org.jsoup.nodes.TextNode

/**
 * Result of converting HTML to narration text.
 *
 * @property paragraphs List of speakable paragraph strings
 * @property paragraphMap Mapping from narration paragraph index to original HTML element index
 */
data class ConversionResult(
    val paragraphs: List<String>,
    val paragraphMap: List<ParagraphMapEntry>,
)

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
     * Converts HTML to a list of speakable paragraphs with paragraph mapping.
     *
     * @param html The HTML content to convert
     * @return ConversionResult with paragraphs and mapping to original element indices
     */
    fun convertWithMapping(html: String): ConversionResult {
        if (html.isBlank()) return ConversionResult(emptyList(), emptyList())

        val doc = Jsoup.parse(html)
        val paragraphs = mutableListOf<String>()
        val paragraphMap = mutableListOf<ParagraphMapEntry>()

        // Get all block elements in document order
        val allBlockElements =
            doc
                .body()
                .select(BLOCK_ELEMENTS.joinToString(", "))
                .filter { el -> el.parents().none { it.tagName() in BLOCK_ELEMENTS } }

        // Process each element, tracking the original index
        allBlockElements.forEachIndexed { elementIndex, element ->
            val text = processElement(element)
            if (text.isNotBlank()) {
                val narrationIndex = paragraphs.size
                paragraphs.add(text.trim())
                paragraphMap.add(ParagraphMapEntry(n = narrationIndex, o = elementIndex))
            }
        }

        return ConversionResult(paragraphs, paragraphMap)
    }

    /**
     * Converts HTML to a list of speakable paragraphs.
     *
     * @param html The HTML content to convert
     * @return List of paragraph strings, one per block element. Empty paragraphs are filtered out.
     */
    fun convert(html: String): List<String> = convertWithMapping(html).paragraphs

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
