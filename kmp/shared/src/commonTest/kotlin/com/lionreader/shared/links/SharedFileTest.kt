package com.lionreader.shared.links

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class SharedFileTest {
    @Test
    fun keepsANameWithAnExtensionTheServerConverts() {
        assertEquals("Paper.PDF", uploadFilename("Paper.PDF", "application/octet-stream"))
        assertEquals("notes.md", uploadFilename(" notes.md ", null))
    }

    @Test
    fun addsTheMimeTypesExtensionToANameWithout() {
        assertEquals("Report.pdf", uploadFilename("Report", "application/pdf"))
        assertEquals("Shared file.md", uploadFilename(null, "text/markdown; charset=utf-8"))
    }

    @Test
    fun shortensALongNameKeepingItsExtension() {
        val atLimit = "x".repeat(MAX_UPLOAD_FILENAME_CHARS - 4) + ".pdf"
        assertEquals(atLimit, uploadFilename(atLimit, null))

        val own = uploadFilename("y$atLimit", null)!!
        assertEquals(MAX_UPLOAD_FILENAME_CHARS, own.length)
        assertTrue(own.endsWith(".pdf"))

        val added = uploadFilename("z".repeat(MAX_UPLOAD_FILENAME_CHARS), "text/markdown")!!
        assertEquals(MAX_UPLOAD_FILENAME_CHARS, added.length)
        assertTrue(added.endsWith(".md"))
    }

    @Test
    fun rejectsTypesTheServerDoesntConvert() {
        assertNull(uploadFilename("photo.jpg", "image/jpeg"))
        assertNull(uploadFilename("archive", null))
    }
}
