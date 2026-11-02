package com.lionreader.app.narration

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.lionreader.shared.api.ENHANCED_VOICES
import com.lionreader.shared.api.EnhancedVoiceFiles
import com.lionreader.shared.narration.SpeechUnavailable
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.engine.mock.respondError
import io.ktor.http.HttpStatusCode
import java.io.File
import java.nio.file.Files
import java.util.Collections
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
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
        // SpeechUnavailable: narration stops and says why, rather than skip chunk after chunk.
        val failure = runCatching { model().withModel { _, _ -> } }.exceptionOrNull()
        assertTrue(failure is SpeechUnavailable)
    }

    @Test
    fun adtsHeadersMatchAReferenceEncoders() {
        // ffmpeg's (`-c:a aac -profile:a aac_low -f adts`, 24 kHz mono) for frames of these sizes.
        mapOf(
                297 to "FF F1 58 40 26 1F FC",
                359 to "FF F1 58 40 2D DF FC",
                239 to "FF F1 58 40 1E DF FC",
            )
            .forEach { (payload, expected) ->
                assertEquals(
                    expected,
                    StreamingAac.adtsHeader(payload, 24_000).joinToString(" ") {
                        "%02X".format(it)
                    },
                )
            }
    }
}
