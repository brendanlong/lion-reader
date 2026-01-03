package com.lionreader.ui.narration

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class HtmlToTextConverterTest {
    @Test
    fun `convert returns empty list for blank HTML`() {
        val result = HtmlToTextConverter.convert("")
        assertTrue(result.isEmpty())
    }

    @Test
    fun `convert returns empty list for whitespace-only HTML`() {
        val result = HtmlToTextConverter.convert("   \n\t  ")
        assertTrue(result.isEmpty())
    }

    @Test
    fun `convert extracts basic paragraphs`() {
        val html =
            """
            <p>First paragraph</p>
            <p>Second paragraph</p>
            <p>Third paragraph</p>
            """.trimIndent()

        val result = HtmlToTextConverter.convert(html)

        assertEquals(3, result.size)
        assertEquals("First paragraph", result[0])
        assertEquals("Second paragraph", result[1])
        assertEquals("Third paragraph", result[2])
    }

    @Test
    fun `convert filters out empty paragraphs`() {
        val html =
            """
            <p>First paragraph</p>
            <p></p>
            <p>   </p>
            <p>Second paragraph</p>
            """.trimIndent()

        val result = HtmlToTextConverter.convert(html)

        assertEquals(2, result.size)
        assertEquals("First paragraph", result[0])
        assertEquals("Second paragraph", result[1])
    }

    @Test
    fun `convert prefixes h1 and h2 with Heading`() {
        val html =
            """
            <h1>Main Title</h1>
            <h2>Section Title</h2>
            """.trimIndent()

        val result = HtmlToTextConverter.convert(html)

        assertEquals(2, result.size)
        assertEquals("Heading: Main Title", result[0])
        assertEquals("Heading: Section Title", result[1])
    }

    @Test
    fun `convert prefixes h3-h6 with Subheading`() {
        val html =
            """
            <h3>Level 3</h3>
            <h4>Level 4</h4>
            <h5>Level 5</h5>
            <h6>Level 6</h6>
            """.trimIndent()

        val result = HtmlToTextConverter.convert(html)

        assertEquals(4, result.size)
        assertEquals("Subheading: Level 3", result[0])
        assertEquals("Subheading: Level 4", result[1])
        assertEquals("Subheading: Level 5", result[2])
        assertEquals("Subheading: Level 6", result[3])
    }

    @Test
    fun `convert handles code blocks with pre tag`() {
        val html =
            """
            <pre>function hello() {
  console.log("Hello");
}</pre>
            """.trimIndent()

        val result = HtmlToTextConverter.convert(html)

        assertEquals(1, result.size)
        assertTrue(result[0].startsWith("Code block:"))
        assertTrue(result[0].endsWith("End code block."))
        assertTrue(result[0].contains("function hello()"))
    }

    @Test
    fun `convert handles blockquotes`() {
        val html =
            """
            <blockquote>This is a quoted text from someone wise.</blockquote>
            """.trimIndent()

        val result = HtmlToTextConverter.convert(html)

        assertEquals(1, result.size)
        assertEquals("Quote: This is a quoted text from someone wise. End quote.", result[0])
    }

    @Test
    fun `convert handles figures with alt text`() {
        val html =
            """
            <figure>
              <img src="photo.jpg" alt="A beautiful sunset">
            </figure>
            """.trimIndent()

        val result = HtmlToTextConverter.convert(html)

        assertEquals(1, result.size)
        assertEquals("Image: A beautiful sunset", result[0])
    }

    @Test
    fun `convert handles figures with figcaption`() {
        val html =
            """
            <figure>
              <img src="photo.jpg">
              <figcaption>The sunset over the ocean</figcaption>
            </figure>
            """.trimIndent()

        val result = HtmlToTextConverter.convert(html)

        assertEquals(1, result.size)
        assertEquals("Image: The sunset over the ocean", result[0])
    }

    @Test
    fun `convert handles figures without alt or caption`() {
        val html =
            """
            <figure>
              <img src="photo.jpg">
            </figure>
            """.trimIndent()

        val result = HtmlToTextConverter.convert(html)

        assertEquals(1, result.size)
        assertEquals("Image", result[0])
    }

    @Test
    fun `convert handles tables`() {
        val html =
            """
            <table>
              <tr>
                <th>Name</th>
                <th>Age</th>
              </tr>
              <tr>
                <td>Alice</td>
                <td>30</td>
              </tr>
              <tr>
                <td>Bob</td>
                <td>25</td>
              </tr>
            </table>
            """.trimIndent()

        val result = HtmlToTextConverter.convert(html)

        assertEquals(1, result.size)
        assertTrue(result[0].startsWith("Table:"))
        assertTrue(result[0].endsWith("End table."))
        assertTrue(result[0].contains("Name, Age"))
        assertTrue(result[0].contains("Alice, 30"))
        assertTrue(result[0].contains("Bob, 25"))
    }

    @Test
    fun `convert replaces inline images with descriptions`() {
        val html =
            """
            <p>This is a paragraph with an inline <img src="icon.png" alt="smiley face"> image.</p>
            """.trimIndent()

        val result = HtmlToTextConverter.convert(html)

        assertEquals(1, result.size)
        assertTrue(result[0].contains("[Image: smiley face]"))
        assertTrue(result[0].contains("This is a paragraph with an inline"))
        assertTrue(result[0].contains("image."))
    }

    @Test
    fun `convert replaces inline images without alt text`() {
        val html =
            """
            <p>Paragraph with <img src="icon.png"> inline image.</p>
            """.trimIndent()

        val result = HtmlToTextConverter.convert(html)

        assertEquals(1, result.size)
        assertTrue(result[0].contains("[Image: image]"))
    }

    @Test
    fun `convert handles list items`() {
        val html =
            """
            <ul>
              <li>First item</li>
              <li>Second item</li>
              <li>Third item</li>
            </ul>
            """.trimIndent()

        val result = HtmlToTextConverter.convert(html)

        assertEquals(3, result.size)
        assertEquals("First item", result[0])
        assertEquals("Second item", result[1])
        assertEquals("Third item", result[2])
    }

    @Test
    fun `convert skips nested block elements to avoid duplication`() {
        val html =
            """
            <blockquote>
              <p>This is a paragraph inside a blockquote.</p>
              <p>Another paragraph in the blockquote.</p>
            </blockquote>
            """.trimIndent()

        val result = HtmlToTextConverter.convert(html)

        // Should only process the blockquote, not the nested paragraphs
        assertEquals(1, result.size)
        assertTrue(result[0].startsWith("Quote:"))
        assertTrue(result[0].contains("This is a paragraph inside a blockquote."))
        assertTrue(result[0].contains("Another paragraph in the blockquote."))
    }

    @Test
    fun `convert handles complex mixed content`() {
        val html =
            """
            <h1>Article Title</h1>
            <p>Introduction paragraph with some <strong>bold</strong> text.</p>
            <h2>First Section</h2>
            <p>Section content here.</p>
            <figure>
              <img src="chart.png" alt="Sales chart">
            </figure>
            <h3>Subsection</h3>
            <blockquote>An inspiring quote.</blockquote>
            <pre>Some code example</pre>
            <ul>
              <li>Point one</li>
              <li>Point two</li>
            </ul>
            <p>Conclusion paragraph.</p>
            """.trimIndent()

        val result = HtmlToTextConverter.convert(html)

        assertEquals(10, result.size)
        assertEquals("Heading: Article Title", result[0])
        assertTrue(result[1].contains("Introduction paragraph"))
        assertEquals("Heading: First Section", result[2])
        assertEquals("Section content here.", result[3])
        assertEquals("Image: Sales chart", result[4])
        assertEquals("Subheading: Subsection", result[5])
        assertEquals("Quote: An inspiring quote. End quote.", result[6])
        assertTrue(result[7].contains("Code block:"))
        assertEquals("Point one", result[8])
        assertEquals("Point two", result[9])
    }

    @Test
    fun `convert handles HTML with only inline elements`() {
        val html =
            """
            <div>
              <span>Some text</span>
              <a href="#">link</a>
              <strong>bold</strong>
            </div>
            """.trimIndent()

        val result = HtmlToTextConverter.convert(html)

        // No block elements, so no paragraphs extracted
        assertTrue(result.isEmpty())
    }

    @Test
    fun `convert preserves text formatting in paragraphs`() {
        val html =
            """
            <p>This has <strong>bold</strong> and <em>italic</em> and <code>code</code> text.</p>
            """.trimIndent()

        val result = HtmlToTextConverter.convert(html)

        assertEquals(1, result.size)
        // Jsoup extracts plain text, so formatting tags are removed
        assertEquals("This has bold and italic and code text.", result[0])
    }

    @Test
    fun `convert handles real-world article structure`() {
        val html =
            """
            <article>
              <h1>How to Build Better Software</h1>
              <p>Software development is both an art and a science.</p>

              <h2>Best Practices</h2>
              <p>Here are some key principles:</p>
              <ul>
                <li>Write clean code</li>
                <li>Test thoroughly</li>
                <li>Document clearly</li>
              </ul>

              <h3>Code Example</h3>
              <pre>function clean() {
  return true;
}</pre>

              <p>Remember: <img src="tip.png" alt="lightbulb"> good code is readable code.</p>
            </article>
            """.trimIndent()

        val result = HtmlToTextConverter.convert(html)

        assertEquals(9, result.size)
        assertEquals("Heading: How to Build Better Software", result[0])
        assertEquals("Software development is both an art and a science.", result[1])
        assertEquals("Heading: Best Practices", result[2])
        assertEquals("Here are some key principles:", result[3])
        assertEquals("Write clean code", result[4])
        assertEquals("Test thoroughly", result[5])
        assertEquals("Document clearly", result[6])
        assertEquals("Subheading: Code Example", result[7])
        assertTrue(result[8].startsWith("Code block:"))
    }

    @Test
    fun `convert trims whitespace from paragraphs`() {
        val html =
            """
            <p>

              Text with extra whitespace

            </p>
            """.trimIndent()

        val result = HtmlToTextConverter.convert(html)

        assertEquals(1, result.size)
        assertEquals("Text with extra whitespace", result[0])
    }

    @Test
    fun `convert handles empty table`() {
        val html = "<table></table>"

        val result = HtmlToTextConverter.convert(html)

        assertEquals(1, result.size)
        assertEquals("Table: . End table.", result[0])
    }

    @Test
    fun `convert handles nested lists as separate items`() {
        val html =
            """
            <ul>
              <li>Parent item
                <ul>
                  <li>Nested item 1</li>
                  <li>Nested item 2</li>
                </ul>
              </li>
              <li>Second parent item</li>
            </ul>
            """.trimIndent()

        val result = HtmlToTextConverter.convert(html)

        // Parent list items should be processed, nested ones should be skipped
        assertEquals(2, result.size)
        assertTrue(result[0].contains("Parent item"))
        assertTrue(result[0].contains("Nested item 1"))
        assertTrue(result[0].contains("Nested item 2"))
        assertEquals("Second parent item", result[1])
    }
}
