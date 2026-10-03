package com.lionreader.app.narration

import android.speech.tts.TextToSpeech
import android.speech.tts.Voice
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.IOException
import java.nio.file.Files
import java.util.Locale
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowTextToSpeech

@RunWith(AndroidJUnit4::class)
// The real Application schedules WorkManager, which these tests don't need.
@Config(application = android.app.Application::class)
class SystemTtsTest {
    @Test
    fun anEngineThatNeverAnswersFailsTheChunkRatherThanHanging() = runTest {
        val tts = SystemTts(ApplicationProvider.getApplicationContext())
        val engine = shadowOf(ShadowTextToSpeech.getLastTextToSpeechInstance())
        engine.onInitListener.onInit(TextToSpeech.SUCCESS)
        val file = Files.createTempFile("tts", ".wav").toFile()

        val error = runCatching { tts.synthesize("Hello.", null, file) }.exceptionOrNull()
        assertEquals(IOException::class, error?.let { it::class })
    }

    @Test
    fun aVoiceInstalledSinceTheVoicesWereLookedUpIsUsed() = runTest {
        val tts = SystemTts(ApplicationProvider.getApplicationContext())
        val engine = shadowOf(ShadowTextToSpeech.getLastTextToSpeechInstance())
        engine.onInitListener.onInit(TextToSpeech.SUCCESS)
        val file = Files.createTempFile("tts", ".wav").toFile()
        ShadowTextToSpeech.addVoice(voice("first"))
        // The engine never finishes here: only the voice it was given matters.
        runCatching { tts.synthesize("Hello.", "first", file) }
        assertEquals("first", engine.currentVoice?.name)

        ShadowTextToSpeech.addVoice(voice("installed"))
        runCatching { tts.synthesize("Hello.", "installed", file) }

        assertEquals("installed", engine.currentVoice?.name)
    }

    private fun voice(name: String) =
        Voice(name, Locale.US, Voice.QUALITY_NORMAL, Voice.LATENCY_NORMAL, false, emptySet())
}
