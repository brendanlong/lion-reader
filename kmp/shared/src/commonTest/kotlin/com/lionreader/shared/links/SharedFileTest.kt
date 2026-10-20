package com.lionreader.shared.links

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

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
    fun rejectsTypesTheServerDoesntConvert() {
        assertNull(uploadFilename("photo.jpg", "image/jpeg"))
        assertNull(uploadFilename("archive", null))
    }
}
