package com.lionreader.app.narration

import android.content.Context
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import java.io.File
import java.io.IOException
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.suspendCancellableCoroutine

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
            }
        )
    }

    private fun failed(utteranceId: String) {
        pending.remove(utteranceId)?.resumeWithException(IOException("Speech synthesis failed"))
    }

    suspend fun voices(): List<VoiceOption> =
        ready
            .await()
            .voices
            .orEmpty()
            .filterNot { TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED in it.features }
            .sortedWith(compareBy({ it.locale.displayName }, { it.name }))
            .map {
                VoiceOption(
                    it.name,
                    "${it.locale.displayName} · ${it.name}",
                    it.isNetworkConnectionRequired,
                )
            }

    /** Speaks [text] into [file] (WAV) with the voice named [voice], or the engine's default. */
    suspend fun synthesize(text: String, voice: String?, file: File) {
        val tts = ready.await()
        val wanted = voice?.let { name -> tts.voices?.firstOrNull { it.name == name } }
        if (wanted != null && tts.voice?.name != wanted.name) tts.voice = wanted
        if (wanted == null && voice != null) tts.language = Locale.getDefault()
        suspendCancellableCoroutine { continuation ->
            val id = UUID.randomUUID().toString()
            pending[id] = continuation
            continuation.invokeOnCancellation { pending.remove(id) }
            if (tts.synthesizeToFile(text, Bundle(), file, id) != TextToSpeech.SUCCESS) {
                pending.remove(id)
                continuation.resumeWithException(IOException("Speech synthesis failed"))
            }
        }
    }
}
