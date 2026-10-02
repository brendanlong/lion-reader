package com.lionreader.app.narration

import android.speech.tts.TextToSpeech
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.IOException
import java.nio.file.Files
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
}
