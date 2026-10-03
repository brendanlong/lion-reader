package com.lionreader.shared.narration

import com.lionreader.shared.api.ApiFailure
import com.lionreader.shared.api.LionReaderApi
import com.lionreader.shared.api.apiFailure
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.io.IOException
import okio.ByteString.Companion.encodeUtf8

/**
 * Times the server has started answering with cloud speech (not cache hits), app-wide: whether it
 * answers other requests tells a text it can't say from a server that's down.
 */
class CloudSpeechAnswers {
    private val count = MutableStateFlow(0L)

    val value: Long
        get() = count.value

    fun increment() = count.update { it + 1 }
}

/**
 * Streams [text] in [model]'s [voice] to [onAudio]. Until audio starts, trouble is retried and
 * sorted into the [SpeechException]s; once it has, a failure is the player's to handle, so it's
 * thrown as is. Any other exception means this text can't be said, so the narrator skips it.
 */
suspend fun streamCloudSpeech(
    api: LionReaderApi,
    model: String,
    voice: String,
    text: String,
    /** Silence after the speech, so chunks played back to back pause like sentences do. */
    pauseSeconds: Float,
    answers: CloudSpeechAnswers,
    onAudio: suspend (ByteArray) -> Unit,
) {
    val answeredBefore = answers.value
    var wait = 1_000L
    var serverTrouble = false
    var busy = false
    for (attempt in 1..CLOUD_SPEECH_ATTEMPTS) {
        var started = false
        try {
            api.streamSpeech(model, voice, text, pauseSeconds) { bytes ->
                if (!started) answers.increment()
                started = true
                onAudio(bytes)
            }
            return
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (started) throw e
            val why = e.apiFailure()
            when (why) {
                ApiFailure.SignedOut -> throw SpeechUnavailable("Sign in to use cloud voices.")
                // A provider turning down the key is a 422 saying so.
                is ApiFailure.Rejected ->
                    throw SpeechUnavailable(why.message ?: "Cloud voices aren't available.")
                else -> {}
            }
            // Busy (the server's provider, or our rate limit) isn't this text's fault.
            busy = why is ApiFailure.Busy
            serverTrouble = why == ApiFailure.ServerTrouble
        }
        if (attempt < CLOUD_SPEECH_ATTEMPTS) {
            delay(wait)
            wait *= 2
        }
    }
    // It answers other requests but keeps failing this one: it's this text.
    if (serverTrouble && answers.value > answeredBefore) {
        throw IOException("The cloud voice couldn't say this part.")
    }
    throw SpeechInterrupted(
        if (serverTrouble || busy) "The cloud voice isn't working right now."
        else "Couldn't reach the cloud voice. Check your connection."
    )
}

private const val CLOUD_SPEECH_ATTEMPTS = 4

/** What cloud speech is cached by: the same text, voice and pause sound the same. */
fun cloudSpeechCacheKey(model: String, voice: String, pauseSeconds: Float, text: String): String =
    "$model\n$voice\n$pauseSeconds\n$text".encodeUtf8().sha256().hex()
