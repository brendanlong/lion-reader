package com.lionreader.app.narration

import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.DataReader
import androidx.media3.common.Format
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.ParsableByteArray
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.FileDataSource
import androidx.media3.extractor.DefaultExtractorInput
import androidx.media3.extractor.Extractor
import androidx.media3.extractor.ExtractorOutput
import androidx.media3.extractor.PositionHolder
import androidx.media3.extractor.SeekMap
import androidx.media3.extractor.TrackOutput
import androidx.media3.extractor.mp4.FragmentedMp4Extractor
import androidx.media3.extractor.text.SubtitleParser
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.lionreader.shared.api.ENHANCED_VOICES
import com.lionreader.shared.api.EnhancedVoiceFiles
import com.lionreader.shared.narration.SpeechUnavailable
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
    fun streamedSpeechPlaysBackAsWrittenWithItsTiming() {
        // Pieces of uneven length, as Phonon makes them, ending partway through a sample, at every
        // place in a fragment: each sample's time comes out where its audio is, and the audio is
        // what went in, then silence to the end of the last sample.
        val sampleFrames = PhononTts.SAMPLE_RATE * StreamingFmp4.SAMPLE_MS / 1000
        for (samples in 40..80) {
            val length = samples * sampleFrames - sampleFrames / 3
            val audio = FloatArray(length) { ((it % 200) - 100) / 128f }
            val file = File(root, "chunk-$samples.mp4")
            val writer = StreamingFmp4(file, PhononTts.SAMPLE_RATE)
            var at = 0
            for (piece in
                generateSequence(0) { it + 1 }.map { listOf(1920, 37, 5000, 700)[it % 4] }) {
                if (at == length) break
                val end = minOf(length, at + piece)
                writer.write(audio.copyOfRange(at, end))
                at = end
            }
            assertTrue(
                "A fragment is out before the end",
                "moof" in file.readText(Charsets.ISO_8859_1),
            )
            writer.finish(file)

            val extracted = extractSamples(file)
            var frames = 0L
            for ((timeUs, size) in extracted.timesAndSizes) {
                assertEquals(frames * 1_000_000 / PhononTts.SAMPLE_RATE, timeUs)
                frames += size / 2
            }
            assertEquals(samples.toLong() * sampleFrames, frames)
            val decoded =
                ByteBuffer.wrap(extracted.bytes.toByteArray()).order(ByteOrder.LITTLE_ENDIAN)
            for (i in 0 until frames.toInt()) {
                val expected = if (i < length) (audio[i] * Short.MAX_VALUE).toInt() else 0
                assertEquals("sample $i of $samples", expected, decoded.short.toInt())
            }
        }
    }

    private class Samples : TrackOutput {
        val bytes = ByteArrayOutputStream()
        val timesAndSizes = mutableListOf<Pair<Long, Int>>()

        override fun format(format: Format) {
            assertEquals(MimeTypes.AUDIO_RAW, format.sampleMimeType)
            assertEquals(PhononTts.SAMPLE_RATE, format.sampleRate)
        }

        override fun sampleData(
            input: DataReader,
            length: Int,
            allowEndOfInput: Boolean,
            sampleDataPart: Int,
        ): Int {
            val buffer = ByteArray(length)
            val read = input.read(buffer, 0, length)
            if (read > 0) bytes.write(buffer, 0, read)
            return read
        }

        override fun sampleData(data: ParsableByteArray, length: Int, sampleDataPart: Int) {
            val buffer = ByteArray(length)
            data.readBytes(buffer, 0, length)
            bytes.write(buffer)
        }

        override fun sampleMetadata(
            timeUs: Long,
            flags: Int,
            size: Int,
            offset: Int,
            cryptoData: TrackOutput.CryptoData?,
        ) {
            timesAndSizes += timeUs to size
        }
    }

    /** What the player's MP4 extractor reads from [file]. */
    @OptIn(UnstableApi::class)
    private fun extractSamples(file: File): Samples {
        val samples = Samples()
        val extractor = FragmentedMp4Extractor(SubtitleParser.Factory.UNSUPPORTED)
        extractor.init(
            object : ExtractorOutput {
                override fun track(id: Int, type: Int): TrackOutput = samples

                override fun endTracks() {}

                override fun seekMap(seekMap: SeekMap) {}
            }
        )
        val source = FileDataSource()
        val length = source.open(DataSpec(Uri.fromFile(file)))
        val input = DefaultExtractorInput(source, 0, length)
        val position = PositionHolder()
        while (extractor.read(input, position) != Extractor.RESULT_END_OF_INPUT) Unit
        source.close()
        return samples
    }
}
