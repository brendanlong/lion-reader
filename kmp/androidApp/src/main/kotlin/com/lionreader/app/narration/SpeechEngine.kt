package com.lionreader.app.narration

import android.net.Uri
import java.io.File

/**
 * A source of narration audio. The narrator chunks the article to the engine's size, keeps about
 * [lookaheadChars] of it synthesized ahead of playback with up to [parallelism] syntheses at once,
 * and plays the chunks in order; playback, highlighting and seeking don't depend on the engine.
 */
interface SpeechEngine {
    val maxChunkChars: Int
    /** Speech runs about 15 characters a second, so 900 is about a minute ahead. */
    val lookaheadChars: Int
    val parallelism: Int

    /**
     * The audio for [text], for the player: a file written into [dir] (the narrator deletes it once
     * played), one in the engine's own cache (which it leaves alone), or a [StreamedAudio] still
     * arriving. Throws [SpeechUnavailable] when narration can't go on with this engine,
     * [SpeechInterrupted] when it can't be reached for now (tried again); any other failure skips
     * just this chunk. Streamed audio that stops partway is synthesized again and replayed.
     */
    suspend fun synthesize(text: String, dir: File, name: String): Uri
}

/** The engine can't narrate (signed out, no key, the voice rejected): stop, and say why. */
class SpeechUnavailable(message: String) : SpeechException(message)

/**
 * The engine can't be reached for now (no connection, server trouble): the narrator plays what it
 * has and tries again, pausing if it runs out for long.
 */
class SpeechInterrupted(message: String) : SpeechException(message)

/** Why a chunk couldn't be synthesized, other than the chunk itself (which is just skipped). */
sealed class SpeechException(message: String) : Exception(message)

/** The device's text-to-speech engine, with the voice named [voice] (null: the default). */
class DeviceVoices(private val tts: SystemTts, private val voice: String?) : SpeechEngine {
    override val maxChunkChars = 400
    override val lookaheadChars = 1200
    override val parallelism = 1

    override suspend fun synthesize(text: String, dir: File, name: String): Uri =
        Uri.fromFile(File(dir, "$name.wav").also { tts.synthesize(text, voice, it) })
}
