package com.lionreader.app.narration

import com.lionreader.shared.api.ENHANCED_VOICES
import com.lionreader.shared.api.EnhancedVoiceFiles
import com.lionreader.shared.narration.SpeechUnavailable
import io.ktor.client.HttpClient
import io.ktor.client.plugins.HttpTimeoutConfig
import io.ktor.client.plugins.timeout
import io.ktor.client.request.prepareGet
import io.ktor.client.statement.bodyAsChannel
import io.ktor.http.isSuccess
import io.ktor.utils.io.readAvailable
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.Executors
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/**
 * Enhanced voices' model on this device: the files the web stores (`EnhancedVoiceFiles`, the same
 * pinned URLs), downloaded on demand into a checkpoint folder as Phonon loads it. Whether it's
 * downloaded is read from what's there; a folder per set of URLs, so a new model never mixes with
 * an old one. Downloading, removing and every call into the model run one at a time.
 */
class EnhancedVoiceModel(
    private val root: File,
    private val http: HttpClient,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) {
    sealed interface State {
        data object Checking : State

        /** [failure]: why the last download didn't finish. */
        data class Missing(val failure: String? = null) : State

        /** [fraction] of the download fetched by this run. */
        data class Downloading(val fraction: Float) : State

        data object Downloaded : State
    }

    private val _state = MutableStateFlow<State>(State.Checking)
    val state: StateFlow<State> = _state.asStateFlow()

    private val dir = File(root, folderName())
    private val files: List<Pair<String, File>> =
        listOf(
            EnhancedVoiceFiles.CONFIG to File(dir, "config.json"),
            EnhancedVoiceFiles.TOKENIZER to File(dir, "tokenizer.json"),
            EnhancedVoiceFiles.WEIGHTS to File(dir, "model.q8.gguf"),
        ) + ENHANCED_VOICES.map { it.url to File(dir, "voices/${it.id}.safetensors") }

    private val mutex = Mutex()

    /** The native model takes calls from one thread at a time: this one. */
    private val modelThread =
        Executors.newSingleThreadExecutor { Thread(it, "enhanced-voices") }.asCoroutineDispatcher()

    /** Loaded on the model thread, and only touched there. */
    private var tts: PhononTts? = null

    /** Bumped by [remove], so what's speaking stops at its next piece of audio. */
    @Volatile private var removals = 0

    /** Reads [state] from what's stored. */
    suspend fun check() {
        mutex.withLock { _state.value = withContext(io) { stored() } }
    }

    /**
     * Fetches whatever of the model and voices isn't stored yet. A failure ends in [State.Missing]
     * saying why (what was fetched stays, for the next try).
     */
    suspend fun download() = mutex.withLock {
        withContext(io) {
            root.listFiles()?.filter { it != dir }?.forEach { it.deleteRecursively() }
            var fetched = 0L
            _state.value = State.Downloading(0f)
            var failure: String? = null
            try {
                for ((url, file) in files) {
                    if (file.exists()) continue
                    fetch(url, file) { bytes ->
                        fetched += bytes
                        _state.value =
                            State.Downloading(
                                (fetched.toFloat() / EnhancedVoiceFiles.DOWNLOAD_BYTES)
                                    .coerceAtMost(1f)
                            )
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                failure = e.message ?: "The download failed"
            } finally {
                _state.value =
                    stored().let { if (it is State.Missing) State.Missing(failure) else it }
            }
        }
    }

    /** Frees the model and deletes its files. */
    suspend fun remove() = mutex.withLock {
        removals++
        // On the model's thread, so nothing loads it again between the two.
        withContext(modelThread) {
            tts?.close()
            tts = null
            root.deleteRecursively()
        }
        _state.value = State.Missing()
    }

    /**
     * [block] with the model loaded, on its thread. [stopped] tells [block] that a [remove] came
     * since it started, so it can stop speaking. Throws [SpeechUnavailable] when the model isn't
     * downloaded or won't load: narration can't go on with it then (see [SpeechEngine]).
     */
    internal suspend fun <T> withModel(block: (PhononTts, stopped: () -> Boolean) -> T): T {
        val since = removals
        return withContext(modelThread) {
            val model =
                tts
                    ?: run {
                        if (stored() != State.Downloaded) {
                            throw SpeechUnavailable(
                                "Download the enhanced voices in Settings first."
                            )
                        }
                        try {
                                PhononTts(dir)
                            } catch (e: Exception) {
                                throw SpeechUnavailable(
                                    "The enhanced voices couldn't load (${e.message}). Delete and " +
                                        "download them again in Settings."
                                )
                            }
                            .also { tts = it }
                    }
            block(model) { removals != since }
        }
    }

    private fun stored(): State =
        if (files.all { (_, file) -> file.exists() }) State.Downloaded else State.Missing()

    /** [url] into [file], whole or not at all, telling [fetched] of each part as it comes. */
    private suspend fun fetch(url: String, file: File, fetched: (Int) -> Unit) {
        file.parentFile?.mkdirs()
        val partial = File(file.path + ".part")
        http
            .prepareGet(url) {
                // The app's 60 s limit on a request is for API calls; 64 MB on a slow connection
                // takes longer. It fails when it stalls instead.
                timeout {
                    requestTimeoutMillis = HttpTimeoutConfig.INFINITE_TIMEOUT_MS
                    socketTimeoutMillis = 30_000
                }
            }
            .execute { response ->
                if (!response.status.isSuccess()) {
                    throw IOException(
                        "Downloading ${file.name} failed: HTTP ${response.status.value}"
                    )
                }
                val body = response.bodyAsChannel()
                val buffer = ByteArray(64 * 1024)
                partial.outputStream().use { out ->
                    while (true) {
                        val read = body.readAvailable(buffer)
                        if (read < 0) break
                        out.write(buffer, 0, read)
                        fetched(read)
                    }
                }
            }
        if (!partial.renameTo(file)) throw IOException("Couldn't store ${file.name}")
    }

    private companion object {
        /** Names the folder for this set of files, so a different set gets its own. */
        fun folderName(): String =
            MessageDigest.getInstance("SHA-256")
                .digest(
                    (listOf(
                            EnhancedVoiceFiles.CONFIG,
                            EnhancedVoiceFiles.TOKENIZER,
                            EnhancedVoiceFiles.WEIGHTS,
                        ) + ENHANCED_VOICES.map { it.url })
                        .joinToString("\n")
                        .toByteArray()
                )
                .take(8)
                .joinToString("") { "%02x".format(it) }
    }
}
