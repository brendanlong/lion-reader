package com.lionreader.shared.account

import com.lionreader.shared.api.ImportEbookRequest
import com.lionreader.shared.sync.FakeServer
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlinx.coroutines.test.runTest

class SaveFileTest {
    private val server = FakeServer()
    private val connection = server.connection()

    @Test
    fun importsAnEbookAsACollection() = runTest {
        val outcome = connection.saveFile("Tale.epub", byteArrayOf(0x50, 0x4b), "share-1")

        assertEquals(SaveOutcome.Saved("A Tale"), outcome)
        assertEquals(listOf(ImportEbookRequest("UEs=", "Tale.epub")), server.ebookImports)
        assertEquals(emptyList(), server.uploads)
    }

    @Test
    fun uploadsAnyOtherFileAsAnArticle() = runTest {
        val outcome = connection.saveFile("Paper.pdf", byteArrayOf(0x25), "share-1")

        assertEquals(SaveOutcome.Saved("Uploaded"), outcome)
        assertEquals(emptyList(), server.ebookImports)
    }
}
