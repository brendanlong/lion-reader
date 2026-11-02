package com.lionreader.app.narration

import android.net.Uri
import androidx.media3.common.C
import androidx.media3.datasource.DataSpec
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.lionreader.shared.api.ENHANCED_VOICES
import com.lionreader.shared.api.EnhancedVoiceFiles
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.engine.mock.respondError
import io.ktor.http.HttpStatusCode
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.file.Files
import java.util.Collections
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class EnhancedVoicesTest {
    private val root: File = Files.createTempDirectory("enhanced-voices").toFile()
    private val fetched: MutableList<String> = Collections.synchronizedList(mutableListOf())

    /** Every file the model needs: the model's three and one per voice. */
    private val allFiles = 3 + ENHANCED_VOICES.size

    private fun model(failing: Set<String> = emptySet()) =
        EnhancedVoiceModel(
            root,
            HttpClient(
                MockEngine { request ->
                    val url = request.url.toString()
                    fetched += url
                    if (url in failing) respondError(HttpStatusCode.ServiceUnavailable)
                    else respond("bytes of $url")
                }
            ),
            Dispatchers.IO,
        )

    @Test
    fun downloadsEveryFileIntoACheckpointFolder() = runBlocking {
        val model = model()
        model.check()
        assertEquals(EnhancedVoiceModel.State.Missing(), model.state.value)

        model.download()

        assertEquals(EnhancedVoiceModel.State.Downloaded, model.state.value)
        assertEquals(allFiles, fetched.size)
        val folder = root.listFiles()!!.single()
        assertEquals(
            "bytes of ${EnhancedVoiceFiles.WEIGHTS}",
            File(folder, "model.q8.gguf").readText(),
        )
        val voice = ENHANCED_VOICES.first()
        assertEquals(
            "bytes of ${voice.url}",
            File(folder, "voices/${voice.id}.safetensors").readText(),
        )
        // A new model (another app session) reads the download from what's stored.
        val again = model()
        again.check()
        assertEquals(EnhancedVoiceModel.State.Downloaded, again.state.value)
    }

    @Test
    fun aFailedDownloadSaysWhyAndResumes() = runBlocking {
        val failing = model(failing = setOf(EnhancedVoiceFiles.TOKENIZER))
        failing.download()
        val state = failing.state.value
        assertTrue(state is EnhancedVoiceModel.State.Missing)
        assertTrue((state as EnhancedVoiceModel.State.Missing).failure!!.contains("503"))

        fetched.clear()
        val model = model()
        model.download()

        assertEquals(EnhancedVoiceModel.State.Downloaded, model.state.value)
        // What was stored before the failure isn't fetched again.
        assertFalse(EnhancedVoiceFiles.CONFIG in fetched)
        assertTrue(EnhancedVoiceFiles.TOKENIZER in fetched)
    }

    @Test
    fun dropsAnOlderModelsFiles() = runBlocking {
        val old = File(root, "an-older-model").apply { mkdirs() }
        File(old, "model.q8.gguf").writeText("old")

        model().download()

        assertFalse(old.exists())
    }

    @Test
    fun removeDeletesTheDownload() = runBlocking {
        val model = model()
        model.download()

        model.remove()

        assertEquals(EnhancedVoiceModel.State.Missing(), model.state.value)
        assertEquals(0, root.listFiles()?.size ?: 0)
    }

    @Test
    fun speakingNeedsTheDownload() = runBlocking {
        val failure = runCatching { model().withModel { _, _ -> } }.exceptionOrNull()
        assertTrue(failure is IllegalStateException)
    }

    @Test
    fun aWavStreamsWithAnOpenSizeAndEndsWithItsOwn() {
        val file = File(root, "chunk.wav")
        val wav = StreamingWav(file, 24_000)
        wav.write(floatArrayOf(0f, 0.5f, -0.5f))
        // Past the range: clipped, not wrapped.
        wav.write(floatArrayOf(2f, -2f))

        val streaming = header(file)
        assertEquals(-1, streaming.getInt(4))
        assertEquals(-1, streaming.getInt(40))

        wav.finish()

        val done = header(file)
        assertEquals(file.length() - 8, done.getInt(4).toLong())
        assertEquals(5 * 2, done.getInt(40))
        assertEquals(24_000, done.getInt(24))
        val samples = ByteBuffer.wrap(file.readBytes(), 44, 10).order(ByteOrder.LITTLE_ENDIAN)
        assertEquals(
            listOf(
                0,
                Short.MAX_VALUE / 2,
                -(Short.MAX_VALUE / 2),
                Short.MAX_VALUE.toInt(),
                -Short.MAX_VALUE.toInt(),
            ),
            List(5) { samples.getShort().toInt() },
        )
        // The player reads all of it: every byte written was handed over as it was.
        assertArrayEquals(file.readBytes(), read(wav.audio.uri))
    }

    private fun header(file: File): ByteBuffer =
        ByteBuffer.wrap(file.readBytes(), 0, 44).order(ByteOrder.LITTLE_ENDIAN)

    /** What the narration player reads of a finished stream. */
    private fun read(uri: Uri): ByteArray {
        val source = NarrationDataSource()
        source.open(DataSpec(uri))
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(4096)
        while (true) {
            val read = source.read(buffer, 0, buffer.size)
            if (read == C.RESULT_END_OF_INPUT) break
            out.write(buffer, 0, read)
        }
        source.close()
        return out.toByteArray()
    }
}
