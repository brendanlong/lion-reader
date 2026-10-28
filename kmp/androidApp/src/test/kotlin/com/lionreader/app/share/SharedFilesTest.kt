package com.lionreader.app.share

import android.app.Application
import android.content.ContentProvider
import android.content.ContentValues
import android.content.pm.ProviderInfo
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.lionreader.shared.api.ServerLimits
import java.io.File
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** One file, as another app's content provider serves it. */
class FakeFileProvider : ContentProvider() {
    override fun onCreate() = true

    override fun getType(uri: Uri): String? = type

    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?,
    ): Cursor = MatrixCursor(arrayOf(OpenableColumns.DISPLAY_NAME)).apply { addRow(arrayOf(name)) }

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        val file = File.createTempFile("shared", null).apply { writeBytes(bytes) }
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null

    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?) = 0

    override fun update(
        uri: Uri,
        values: ContentValues?,
        selection: String?,
        selectionArgs: Array<out String>?,
    ) = 0

    companion object {
        var name: String? = null
        var type: String? = null
        var bytes = ByteArray(0)
    }
}

@RunWith(AndroidJUnit4::class)
@Config(application = Application::class)
class SharedFilesTest {
    private val context: Application = ApplicationProvider.getApplicationContext()

    private fun provider(authority: String, packageName: String): Uri {
        val info =
            ProviderInfo().apply {
                this.authority = authority
                this.packageName = packageName
                name = FakeFileProvider::class.java.name
            }
        Robolectric.buildContentProvider(FakeFileProvider::class.java).create(info)
        shadowOf(context.packageManager).addOrUpdateProvider(info)
        return Uri.parse("content://$authority/file")
    }

    private fun serve(name: String?, type: String?, bytes: ByteArray) {
        FakeFileProvider.name = name
        FakeFileProvider.type = type
        FakeFileProvider.bytes = bytes
    }

    private val otherApp = "com.example.files"

    @Test
    fun copiesAnotherAppsFileNamedForItsType() {
        val uri = provider("com.example.files.provider", otherApp)
        val pdf = "%PDF-1.7 a document".toByteArray()
        serve("Paper", "application/pdf", pdf)

        val result = copySharedFile(context, uri, sharedType = null) as CopyResult.Copied

        assertEquals("Paper.pdf", result.file.filename)
        assertArrayEquals(pdf, File(result.file.path).readBytes())
    }

    @Test
    fun theProvidersTypeBeatsTheSenders() {
        val uri = provider("com.example.files.provider", otherApp)
        serve("preview", "image/jpeg", byteArrayOf(1, 2, 3))

        val result = copySharedFile(context, uri, sharedType = "text/plain")

        assertTrue(result is CopyResult.Failed)
    }

    @Test
    fun readsOnlyAnotherAppsContent() {
        val own = provider("${context.packageName}.files", context.packageName)
        serve("notes.md", "text/markdown", "# Notes".toByteArray())
        val file = Uri.fromFile(File(context.filesDir, "secret.md").apply { writeText("x") })

        for (uri in listOf(own, file)) {
            val result = copySharedFile(context, uri, "text/markdown")
            assertEquals(
                CopyResult.Failed("Lion Reader can only save files shared by another app."),
                result,
            )
        }
    }

    @Test
    fun rejectsAFileOverTheUploadLimitAndKeepsNoCopy() {
        val uri = provider("com.example.files.provider", otherApp)
        serve("big.pdf", "application/pdf", ByteArray(ServerLimits.UPLOAD_BYTES + 1))

        val result = copySharedFile(context, uri, sharedType = null)

        assertEquals(CopyResult.Failed("That file is too large to save."), result)
        assertFalse(sharedFileCopy(context, uri).exists())
    }

    @Test
    fun acceptsAFileExactlyAtTheUploadLimit() {
        val uri = provider("com.example.files.provider", otherApp)
        serve("big.pdf", "application/pdf", ByteArray(ServerLimits.UPLOAD_BYTES))

        assertTrue(copySharedFile(context, uri, sharedType = null) is CopyResult.Copied)
    }

    @Test
    fun holdsAnEbookToTheEbookLimit() {
        val uri = provider("com.example.files.provider", otherApp)
        serve("book.epub", "application/epub+zip", ByteArray(ServerLimits.EBOOK_UPLOAD_BYTES))
        assertTrue(copySharedFile(context, uri, sharedType = null) is CopyResult.Copied)

        serve("book.epub", "application/epub+zip", ByteArray(ServerLimits.EBOOK_UPLOAD_BYTES + 1))
        assertEquals(
            CopyResult.Failed("That file is too large to save."),
            copySharedFile(context, uri, sharedType = null),
        )
    }
}
