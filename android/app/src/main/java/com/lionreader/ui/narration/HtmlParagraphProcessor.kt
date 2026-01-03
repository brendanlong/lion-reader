package com.lionreader.ui.narration

import org.jsoup.Jsoup
import org.jsoup.nodes.Element
import org.jsoup.select.NodeTraversor
import org.jsoup.select.NodeVisitor

/**
 * Processes HTML content to add paragraph IDs for highlighting during narration.
 *
 * Block-level elements (p, h1-h6, blockquote, pre, li, figure, table) get assigned
 * data-para-id attributes in document order (para-0, para-1, etc.). Standalone images
 * (not inside other block elements) also get their own paragraph IDs.
 *
 * This mirrors the logic from the web app's client-paragraph-ids.ts.
 */
object HtmlParagraphProcessor {
    /**
     * Block-level elements that can be highlighted during narration.
     */
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
            "ul",
            "ol",
            "li",
            "figure",
            "table",
        )

    /**
     * Result of processing HTML content.
     *
     * @property html HTML with data-para-id attributes added to block elements
     * @property paragraphCount Number of paragraph elements marked
     */
    data class ProcessResult(
        val html: String,
        val paragraphCount: Int,
    )

    /**
     * Adds data-para-id attributes to block-level elements in HTML content.
     *
     * The IDs are assigned in document order (para-0, para-1, etc.) matching
     * how the narration paragraphs are indexed during playback.
     *
     * @param html The HTML content to process
     * @return ProcessResult containing the processed HTML and paragraph count
     */
    fun addParagraphIds(html: String): ProcessResult {
        if (html.isBlank()) {
            return ProcessResult("", 0)
        }

        val doc = Jsoup.parse(html)
        val body = doc.body()

        // Collect elements in document order using DOM traversal
        val elementsToMark = mutableListOf<Element>()

        NodeTraversor.traverse(
            object : NodeVisitor {
                override fun head(
                    node: org.jsoup.nodes.Node,
                    depth: Int,
                ) {
                    if (node is Element) {
                        val tagName = node.tagName().lowercase()

                        // Check if this is a block element that should be marked
                        if (tagName in BLOCK_ELEMENTS) {
                            // Only mark if not nested inside another block element
                            val isNested =
                                node.parents().any { parent ->
                                    parent.tagName().lowercase() in BLOCK_ELEMENTS
                                }
                            if (!isNested) {
                                elementsToMark.add(node)
                            }
                        }

                        // Check for standalone images
                        if (tagName == "img") {
                            val isInsideBlock =
                                node.parents().any { parent ->
                                    parent.tagName().lowercase() in BLOCK_ELEMENTS
                                }
                            if (!isInsideBlock) {
                                elementsToMark.add(node)
                            }
                        }
                    }
                }

                override fun tail(
                    node: org.jsoup.nodes.Node,
                    depth: Int,
                ) {
                    // No action needed on tail
                }
            },
            body,
        )

        // Assign paragraph IDs in document order
        elementsToMark.forEachIndexed { index, element ->
            element.attr("data-para-id", "para-$index")
        }

        // Return the inner HTML of the body
        return ProcessResult(
            html = body.html(),
            paragraphCount = elementsToMark.size,
        )
    }
}
