package com.lionreader.app.narration

import androidx.annotation.OptIn
import androidx.media3.common.DataReader
import androidx.media3.common.Format
import androidx.media3.common.util.ParsableByteArray
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.ByteArrayDataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.extractor.DefaultExtractorInput
import androidx.media3.extractor.Extractor
import androidx.media3.extractor.ExtractorOutput
import androidx.media3.extractor.PositionHolder
import androidx.media3.extractor.SeekMap
import androidx.media3.extractor.TrackOutput
import androidx.media3.extractor.mp3.Mp3Extractor
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/**
 * A 1s MP3 and a 2s MP3 back to back, as a cloud voice can return a two-sentence chunk; the first
 * starts with an ID3 tag and an Info header counting only its own frames.
 */
private fun twoSentences(): ByteArray =
    Mp3Test::class.java.getResourceAsStream("/two-sentences.mp3")!!.use { it.readBytes() }

@RunWith(AndroidJUnit4::class)
// The real Application schedules WorkManager, which these tests don't need.
@Config(application = android.app.Application::class)
@OptIn(UnstableApi::class)
class Mp3Test {
    @Test
    fun thePlayerStopsAtTheFirstPieceWithTheHeader() {
        // What the fix is for: if this ever reads the whole file, the fix isn't needed.
        assertTrue(playedSeconds(twoSentences()) < 1.5)
    }

    @Test
    fun withoutTheHeaderThePlayerReadsItAll() {
        assertEquals(3.0, playedSeconds(withoutSeekHeader(twoSentences())), 0.2)
    }

    @Test
    fun theHeaderIsFoundPastPaddingAndMoreId3Tags() {
        val audio = twoSentences()
        val id3Size = 10 + (6..9).fold(0) { total, i -> (total shl 7) or audio[i].toInt() }
        val id3 = audio.copyOf(id3Size)
        val padded = id3 + ByteArray(64) + audio.copyOfRange(id3Size, audio.size)
        val twoTags = id3 + audio

        assertEquals(3.0, playedSeconds(withoutSeekHeader(padded)), 0.2)
        assertEquals(3.0, playedSeconds(withoutSeekHeader(twoTags)), 0.2)
    }

    @Test
    fun aFileIsFixedInPlace() {
        val file = File.createTempFile("speech", ".mp3").apply { writeBytes(twoSentences()) }

        blankSeekHeader(file)

        assertEquals(twoSentences().size.toLong(), file.length())
        assertEquals(3.0, playedSeconds(file.readBytes()), 0.2)
        file.delete()
    }

    @Test
    fun audioWithoutAHeaderIsUntouched() {
        val fixed = withoutSeekHeader(twoSentences())
        assertSame(fixed, withoutSeekHeader(fixed))
        val notAudio = "not an mp3".toByteArray()
        assertSame(notAudio, withoutSeekHeader(notAudio))
    }

    /** How much audio ExoPlayer's MP3 extractor gets out of [audio]. */
    private fun playedSeconds(audio: ByteArray): Double {
        var lastSampleUs = 0L
        val track =
            object : TrackOutput {
                override fun format(format: Format) {}

                override fun sampleData(
                    input: DataReader,
                    length: Int,
                    allowEndOfInput: Boolean,
                    sampleDataPart: Int,
                ): Int {
                    return input.read(ByteArray(length), 0, length)
                }

                override fun sampleData(data: ParsableByteArray, length: Int, sampleDataPart: Int) {
                    data.skipBytes(length)
                }

                override fun sampleMetadata(
                    timeUs: Long,
                    flags: Int,
                    size: Int,
                    offset: Int,
                    cryptoData: TrackOutput.CryptoData?,
                ) {
                    lastSampleUs = maxOf(lastSampleUs, timeUs)
                }
            }
        val output =
            object : ExtractorOutput {
                override fun track(id: Int, type: Int) = track

                override fun endTracks() {}

                override fun seekMap(seekMap: SeekMap) {}
            }
        val extractor = Mp3Extractor()
        extractor.init(output)
        val position = PositionHolder()
        var start = 0L
        while (true) {
            val source = ByteArrayDataSource(audio)
            source.open(DataSpec.Builder().setUri("data:").setPosition(start).build())
            val input = DefaultExtractorInput(source, start, audio.size.toLong())
            when (extractor.read(input, position)) {
                Extractor.RESULT_END_OF_INPUT -> break
                Extractor.RESULT_SEEK -> start = position.position
                else -> start = input.position
            }
            source.close()
        }
        return lastSampleUs / 1_000_000.0
    }
}
