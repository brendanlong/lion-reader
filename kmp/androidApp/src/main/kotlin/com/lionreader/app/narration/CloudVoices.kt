package com.lionreader.app.narration

import android.net.Uri
import com.lionreader.shared.api.LionReaderApi
import com.lionreader.shared.api.MAX_CLOUD_SPEECH_CHARS
import com.lionreader.shared.narration.CloudSpeechAnswers
import com.lionreader.shared.narration.cloudSpeechCacheKey
import com.lionreader.shared.narration.streamCloudSpeech
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext

/**
 * What every [CloudVoices] shares, however many there have been: the cloud voices' requests run on,
 * filling the cache, after the narrator has moved to another article (and another engine).
 */
class CloudSpeechRequests {
    /**
     * Requests streaming at once, as many as on the web: enough that a provider streaming slower
     * than playback can keep up by generating several chunks at once, but bounded, since providers
     * limit concurrent requests per key and several listeners share the server's.
     */
    internal val streams = Semaphore(4)

    /**
     * Streams by cache key, from the request until the audio is all in, so the same text twice is
     * one request. Each completes once its audio starts.
     */
    internal val inFlight = ConcurrentHashMap<String, Deferred<StreamedAudio>>()

    internal val answers = CloudSpeechAnswers()
}

/**
 * Cloud voices (Kokoro and friends through the server's `/narration/speech`, on the user's or the
 * server's provider key). Each chunk streams: [synthesize] answers as soon as the first audio is
 * in, and the player reads the rest as it arrives ([StreamedAudio]). Audio is cached on disk by
 * model, voice, pause and text, so listening again doesn't pay again; the cache is trimmed to
 * [cacheBytes], least recently used first. Requests run in [scope], not the caller's: every request
 * is paid for, so one the narrator stops waiting for (the user skipped past it) still finishes into
 * the cache.
 */
class CloudVoices(
    private val api: LionReaderApi,
    private val model: String,
    private val voice: String,
    /** Silence after each chunk, so chunks played back to back pause like sentences do. */
    private val pauseSeconds: Float,
    private val cacheDir: File,
    private val scope: CoroutineScope,
    /** App-wide: an engine is made per article, while requests outlive it. */
    private val requests: CloudSpeechRequests,
    private val io: CoroutineDispatcher = Dispatchers.IO,
    private val cacheBytes: Long = 50L * 1024 * 1024,
) : SpeechEngine {
    override val maxChunkChars = MAX_CLOUD_SPEECH_CHARS
    // Requests take anywhere from under a second to many (the server waits up to 15 s for a busy
    // provider), so 30 seconds ahead. One is started at a time, once the one before has started
    // playing; see [CloudSpeechRequests.streams] for how many run at once.
    override val lookaheadChars = 450
    override val parallelism = 1

    override suspend fun synthesize(text: String, dir: File, name: String): Uri {
        val key = key(text)
        val cached = File(cacheDir, "$key.$EXTENSION")
        if (cached.exists()) {
            withContext(io) { cached.setLastModified(System.currentTimeMillis()) }
            return Uri.fromFile(cached)
        }
        val started = CompletableDeferred<StreamedAudio>()
        val stream = stream(key, text, cached, started)
        val running = requests.inFlight.putIfAbsent(key, started)
        if (running == null) stream.start() else stream.cancel()
        return (running ?: started).await().uri
    }

    /**
     * Requests [text] and writes it into [cached] as it arrives, completing [started] once there's
     * audio to play (or with why there won't be). Lazy: started once it's in
     * [CloudSpeechRequests.inFlight], which it leaves when done.
     */
    private fun stream(
        key: String,
        text: String,
        cached: File,
        started: CompletableDeferred<StreamedAudio>,
    ): Job =
        scope.launch(io, CoroutineStart.LAZY) {
            var writer: CacheWriter? = null
            try {
                requests.streams.withPermit {
                    request(text) { bytes ->
                        val into = writer ?: CacheWriter(cached).also { writer = it }
                        into.write(bytes)
                        started.complete(into.audio)
                    }
                }
                val done = writer ?: throw IOException("The cloud voice sent no audio")
                started.complete(done.finish())
                requests.inFlight.remove(key, started)
                trim()
            } catch (e: Throwable) {
                // First, so the narrator's retry makes a new request rather than get this one.
                requests.inFlight.remove(key, started)
                writer?.fail(e)
                started.completeExceptionally(e)
                if (e is CancellationException) throw e
            }
        }

    /** Writes a stream into the cache, handing each part to the player as it comes. */
    private inner class CacheWriter(private val cached: File) {
        private val partial =
            cacheDir.mkdirs().let {
                File.createTempFile(cached.nameWithoutExtension, ".part", cacheDir)
            }
        private val out = FileOutputStream(partial)

        /** What the player reads. */
        val audio = StreamedAudio(partial)

        fun write(bytes: ByteArray) {
            out.write(bytes)
            audio.appended(bytes.size)
        }

        fun finish(): StreamedAudio {
            out.close()
            // Not cached if it can't be moved, but it plays from where it is.
            audio.finish(cached)
            return audio
        }

        fun fail(cause: Throwable) {
            // Failed before the file goes, so a reader opening it now is told
            // the stream broke rather than that there's no file.
            audio.fail(cause as? Exception ?: IOException(cause))
            out.close()
            partial.delete()
        }
    }

    /** Streams [text] to [onAudio] (on IO: the caller's [scope] dispatcher). */
    private suspend fun request(text: String, onAudio: suspend (ByteArray) -> Unit) =
        streamCloudSpeech(api, model, voice, text, pauseSeconds, requests.answers, onAudio)

    private fun key(text: String): String = cloudSpeechCacheKey(model, voice, pauseSeconds, text)

    private fun trim() {
        val files = cacheDir.listFiles { file -> file.extension == EXTENSION }.orEmpty()
        // Leftovers of a write the process didn't live to finish.
        cacheDir
            .listFiles { file ->
                file.extension == "part" &&
                    file.lastModified() < System.currentTimeMillis() - 10 * 60_000
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
        /** AAC in fragmented MP4, as the server sends it. */
        const val EXTENSION = "mp4"
    }
}
