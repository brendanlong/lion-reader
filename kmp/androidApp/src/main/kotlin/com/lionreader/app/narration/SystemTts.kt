package com.lionreader.app.narration

import android.content.Context
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import java.io.File
import java.io.IOException
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull

/** A voice of the device's text-to-speech engine. */
data class VoiceOption(val name: String, val label: String, val online: Boolean)

/**
 * The device's text-to-speech engine, synthesizing to files so playback goes through the media
 * player (and its session, notification and audio focus) like any other audio.
 */
class SystemTts(context: Context) {
    private val ready = CompletableDeferred<TextToSpeech>()
    private val pending = ConcurrentHashMap<String, CancellableContinuation<Unit>>()
    private lateinit var engine: TextToSpeech

    init {
        engine =
            TextToSpeech(context.applicationContext) { status ->
                if (status == TextToSpeech.SUCCESS) ready.complete(engine)
                else ready.completeExceptionally(IOException("No text-to-speech engine"))
            }
        engine.setOnUtteranceProgressListener(
            object : UtteranceProgressListener() {
                override fun onStart(utteranceId: String) {}

                override fun onDone(utteranceId: String) {
                    pending.remove(utteranceId)?.resume(Unit)
                }

                @Deprecated("Deprecated in Java")
                override fun onError(utteranceId: String) = failed(utteranceId)

                override fun onError(utteranceId: String, errorCode: Int) = failed(utteranceId)

                // Stopped before it finished: by us (nothing's waiting then), or by the engine.
                override fun onStop(utteranceId: String, interrupted: Boolean) = failed(utteranceId)
            }
        )
    }

    /**
     * The engine's voices as last listed: asking for them is asking for all of them (hundreds, over
     * binder). Listed again for a voice not in it, which may have been installed since.
     */
    @Volatile private var voicesByName: Map<String, Voice> = emptyMap()

    private fun listVoices(tts: TextToSpeech): Collection<Voice> =
        tts.voices.orEmpty().also { voices -> voicesByName = voices.associateBy { it.name } }

    private fun voiceNamed(tts: TextToSpeech, name: String): Voice? =
        voicesByName[name] ?: listVoices(tts).firstOrNull { it.name == name }

    private fun failed(utteranceId: String) {
        pending.remove(utteranceId)?.resumeWithException(IOException("Speech synthesis failed"))
    }

    suspend fun voices(): List<VoiceOption> =
        listVoices(ready.await())
            .filterNot { TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED in it.features }
            .sortedWith(compareBy({ it.locale.displayName }, { it.name }))
            .map {
                VoiceOption(
                    it.name,
                    "${it.locale.displayName} · ${it.name}",
                    it.isNetworkConnectionRequired,
                )
            }

    /**
     * Speaks [text] into [file] (WAV) with the voice named [voice], or the engine's default. Fails
     * (so the narrator skips the chunk) if the engine doesn't finish in time: one whose service
     * died may never call back.
     */
    suspend fun synthesize(text: String, voice: String?, file: File) {
        val tts = ready.await()
        // A voice that's gone (uninstalled) falls back to the default too.
        val wanted = voice?.let { voiceNamed(tts, it) } ?: tts.defaultVoice
        if (wanted != null && tts.voice?.name != wanted.name) tts.voice = wanted
        withTimeoutOrNull(TIMEOUT_MILLIS + text.length * TIMEOUT_MILLIS_PER_CHAR) {
            synthesizeToFile(tts, text, file)
        } ?: throw IOException("Speech synthesis timed out")
    }

    private suspend fun synthesizeToFile(tts: TextToSpeech, text: String, file: File) =
        suspendCancellableCoroutine<Unit> { continuation ->
            val id = UUID.randomUUID().toString()
            pending[id] = continuation
            continuation.invokeOnCancellation {
                // Only one synthesis runs at a time; don't make the next wait for it.
                pending.remove(id)
                tts.stop()
            }
            if (tts.synthesizeToFile(text, Bundle(), file, id) != TextToSpeech.SUCCESS) {
                pending.remove(id)
                continuation.resumeWithException(IOException("Speech synthesis failed"))
            }
        }

    private companion object {
        /** A synthesis gets this long and [TIMEOUT_MILLIS_PER_CHAR] more per character. */
        const val TIMEOUT_MILLIS = 30_000L
        const val TIMEOUT_MILLIS_PER_CHAR = 100L
    }
}
