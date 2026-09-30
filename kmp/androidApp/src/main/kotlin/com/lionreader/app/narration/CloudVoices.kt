package com.lionreader.app.narration

import com.lionreader.shared.api.ApiException
import com.lionreader.shared.api.LionReaderApi
import com.lionreader.shared.api.MAX_CLOUD_SPEECH_CHARS
import java.io.File
import java.security.MessageDigest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

/**
 * Cloud voices (Kokoro and friends through the server's `narration.synthesize`, on the user's or
 * the server's OpenRouter key). Audio is cached on disk by model, voice and text, so listening
 * again doesn't pay again; the cache is trimmed to [cacheBytes], least recently used first.
 */
class CloudVoices(
    private val api: LionReaderApi,
    private val model: String,
    private val voice: String,
    private val cacheDir: File,
    private val cacheBytes: Long = 50L * 1024 * 1024,
) : SpeechEngine {
    override val maxChunkChars = MAX_CLOUD_SPEECH_CHARS
    // Requests take anywhere from under a second to many, so a minute ahead,
    // a few at a time (as the web does).
    override val lookaheadChars = 900
    override val parallelism = 3

    override suspend fun synthesize(text: String, dir: File, name: String): File {
        val cached = File(cacheDir, "${key(text)}.mp3")
        if (cached.exists()) {
            cached.setLastModified(System.currentTimeMillis())
            return cached
        }
        val audio = request(text)
        return withContext(Dispatchers.IO) {
            cacheDir.mkdirs()
            val partial = File(cacheDir, "${cached.name}.part")
            partial.writeBytes(audio)
            partial.renameTo(cached)
            trim()
            cached
        }
    }

    private suspend fun request(text: String): ByteArray {
        var wait = 1_000L
        repeat(RETRIES) {
            try {
                return api.synthesizeSpeech(model, voice, text)
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException) {
                if (e.status == 0) throw SpeechUnavailable("Sign in to use cloud voices.")
                if (e.isPermanent || (e.status in 400..499 && e.status != 429)) {
                    throw SpeechUnavailable(e.serverMessage ?: "Cloud voices aren't available.")
                }
            } catch (_: Exception) {
                // Network: try again below.
            }
            delay(wait)
            wait *= 2
        }
        throw SpeechUnavailable("Couldn't reach the cloud voice. Check your connection.")
    }

    private fun key(text: String): String =
        MessageDigest.getInstance("SHA-256")
            .digest("$model\n$voice\n$text".toByteArray())
            .joinToString("") { "%02x".format(it) }

    private fun trim() {
        val files = cacheDir.listFiles { file -> file.extension == "mp3" }.orEmpty()
        var size = files.sumOf { it.length() }
        for (file in files.sortedBy { it.lastModified() }) {
            if (size <= cacheBytes) break
            size -= file.length()
            file.delete()
        }
    }

    private companion object {
        const val RETRIES = 4
    }
}
