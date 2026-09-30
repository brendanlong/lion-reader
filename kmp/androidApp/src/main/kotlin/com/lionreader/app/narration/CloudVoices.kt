package com.lionreader.app.narration

import com.lionreader.shared.api.ApiException
import com.lionreader.shared.api.LionReaderApi
import com.lionreader.shared.api.MAX_CLOUD_SPEECH_CHARS
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.delay

/**
 * Cloud voices (Kokoro and friends through the server's `narration.synthesize`, on the user's or
 * the server's OpenRouter key). Audio is cached on disk by model, voice and text, so listening
 * again doesn't pay again; the cache is trimmed to [cacheBytes], least recently used first.
 * Requests run in [scope], not the caller's: every request is paid for, so one the narrator stops
 * waiting for (the user skipped past it) still finishes into the cache.
 */
class CloudVoices(
    private val api: LionReaderApi,
    private val model: String,
    private val voice: String,
    private val cacheDir: File,
    private val scope: CoroutineScope,
    private val io: CoroutineDispatcher = Dispatchers.IO,
    private val cacheBytes: Long = 50L * 1024 * 1024,
) : SpeechEngine {
    /** Requests in flight by cache key, so the same text twice is one request. */
    private val inFlight = ConcurrentHashMap<String, Deferred<File>>()

    override val maxChunkChars = MAX_CLOUD_SPEECH_CHARS
    // Requests take anywhere from under a second to many, so a minute ahead,
    // a few at a time (as the web does).
    override val lookaheadChars = 900
    override val parallelism = 3

    override suspend fun synthesize(text: String, dir: File, name: String): File {
        val key = key(text)
        val cached = File(cacheDir, "$key.mp3")
        if (cached.exists()) {
            cached.setLastModified(System.currentTimeMillis())
            return cached
        }
        return inFlight
            .computeIfAbsent(key) {
                scope.async(io) {
                    try {
                        store(request(text), cached)
                    } finally {
                        inFlight.remove(key)
                    }
                }
            }
            .await()
    }

    private fun store(audio: ByteArray, cached: File): File {
        cacheDir.mkdirs()
        val partial = File.createTempFile(cached.nameWithoutExtension, ".part", cacheDir)
        partial.writeBytes(audio)
        if (!partial.renameTo(cached)) {
            partial.delete()
            throw IOException("Couldn't cache speech")
        }
        trim()
        return cached
    }

    /** On IO (the caller's [scope] dispatcher): the audio arrives as a large base64 JSON body. */
    private suspend fun request(text: String): ByteArray {
        var wait = 1_000L
        var serverTrouble = false
        for (attempt in 1..ATTEMPTS) {
            try {
                return api.synthesizeSpeech(model, voice, text)
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException) {
                if (e.status == 0) throw SpeechUnavailable("Sign in to use cloud voices.")
                if (e.isPermanent || (e.status in 400..499 && e.status != 429)) {
                    throw SpeechUnavailable(e.serverMessage ?: "Cloud voices aren't available.")
                }
                serverTrouble = e.status >= 500
            } catch (_: Exception) {
                // Network: try again below.
                serverTrouble = false
            }
            if (attempt < ATTEMPTS) {
                delay(wait)
                wait *= 2
            }
        }
        throw SpeechUnavailable(
            if (serverTrouble) "The cloud voice isn't working right now. Try again later."
            else "Couldn't reach the cloud voice. Check your connection."
        )
    }

    private fun key(text: String): String =
        MessageDigest.getInstance("SHA-256")
            .digest("$model\n$voice\n$text".toByteArray())
            .joinToString("") { "%02x".format(it) }

    private fun trim() {
        val files = cacheDir.listFiles { file -> file.extension == "mp3" }.orEmpty()
        // Leftovers of a write the process didn't live to finish.
        cacheDir
            .listFiles { file ->
                file.extension == "part" &&
                    file.lastModified() < System.currentTimeMillis() - 60_000
            }
            ?.forEach { it.delete() }
        var size = files.sumOf { it.length() }
        for (file in files.sortedBy { it.lastModified() }) {
            if (size <= cacheBytes) break
            size -= file.length()
            file.delete()
        }
    }

    private companion object {
        const val ATTEMPTS = 4
    }
}
