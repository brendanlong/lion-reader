package com.lionreader.app.narration

import android.content.ComponentName
import android.content.Context
import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.SilenceMediaSource
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture
import com.lionreader.app.AppSettings
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/** What to narrate: an article's paragraphs, as the reader's narration script extracted them. */
data class NarratedArticle(
    val entryId: String,
    val title: String,
    val source: String?,
    val paragraphs: List<String>,
    /** The list it was started from, in order; playback can carry on down it. */
    val queue: List<String> = listOf(entryId),
)

/**
 * The article being narrated, the paragraph being spoken, and whether it's playing. [waiting]: it
 * should be playing but has no audio yet (the engine is getting ready, or the next chunk is still
 * being synthesized).
 */
data class NarrationState(
    val entryId: String,
    val title: String,
    val paragraph: Int,
    val playing: Boolean,
    val waiting: Boolean = false,
    /** [NarratedArticle.queue], for opening the article where the list left off. */
    val queue: List<String> = listOf(entryId),
)

/**
 * Narrates one article at a time with the [SpeechEngine] the settings pick: synthesizes it chunk by
 * chunk a little ahead of the player and plays the chunks through one ExoPlayer, which
 * [NarrationService] exposes as a media session (notification, lock screen, headset buttons,
 * background playback). Played chunks are dropped, so the files on disk stay a handful however long
 * the article. A chunk the engine can't say is skipped, so the playlist can have gaps: items are
 * found by their chunk index (the media id).
 *
 * Whenever there's no audio yet (the engine is getting ready, the first chunk is being synthesized,
 * the next article is being found) the player plays silence instead. It never goes empty or ends
 * midway: an empty playlist takes down media3's notification and foreground service, which it can't
 * restart from the background (continuing to the next article with the screen off), and an ended
 * one turns the notification's and headset's pause into a replay.
 *
 * Main thread only (ExoPlayer's rule).
 */
class Narrator(
    private val context: Context,
    private val settings: () -> AppSettings,
    private val engineFor: suspend (AppSettings) -> SpeechEngine,
    /** What to narrate once an article ends, if anything (continuous playback). */
    private val next: suspend (NarratedArticle) -> NarratedArticle?,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val dir = File(context.cacheDir, "narration")

    private val _state = MutableStateFlow<NarrationState?>(null)
    val state: StateFlow<NarrationState?> = _state.asStateFlow()

    private val _errors =
        MutableSharedFlow<String>(
            extraBufferCapacity = 1,
            onBufferOverflow = BufferOverflow.DROP_OLDEST,
        )

    /** Why narration stopped on its own, for the user. */
    val errors: SharedFlow<String> = _errors.asSharedFlow()

    val player: ExoPlayer by lazy {
        ExoPlayer.Builder(context)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    .setContentType(C.AUDIO_CONTENT_TYPE_SPEECH)
                    .build(),
                /* handleAudioFocus= */ true,
            )
            .setHandleAudioBecomingNoisy(true)
            .build()
            .also { it.addListener(listener) }
    }

    private var article: NarratedArticle? = null
    private var engine: SpeechEngine? = null
    private var chunks: List<SpeechChunk> = emptyList()
    /** Characters before each chunk, for measuring how far ahead synthesis is. */
    private var offsets: IntArray = IntArray(0)
    private var speed = 1f
    private val playingChunk = MutableStateFlow(0)
    private var preparing: Job? = null
    /** Finding the next article, once this one's ended. */
    private var continuation: Job? = null
    private var feeding: Job? = null
    /** Whether the feed has synthesized everything it's going to, and the last chunk it added. */
    private var fed = false
    private var lastAdded: Int? = null
    private var session: ListenableFuture<MediaController>? = null

    fun narrate(article: NarratedArticle, fromParagraph: Int = 0, play: Boolean = true) {
        reset()
        this.article = article
        speed = settings().narrationSpeed
        // Binding a controller starts the service, which puts the player in a
        // media session and keeps playback going in the background.
        if (session == null) {
            session =
                MediaController.Builder(
                        context,
                        SessionToken(context, ComponentName(context, NarrationService::class.java)),
                    )
                    .buildAsync()
        }
        playSilence(article)
        player.playWhenReady = play
        dir.deleteRecursively()
        _state.value =
            NarrationState(
                article.entryId,
                article.title,
                fromParagraph,
                playing = play,
                waiting = true,
                queue = article.queue,
            )
        preparing = scope.launch {
            val engine =
                try {
                    engineFor(settings())
                } catch (e: SpeechUnavailable) {
                    return@launch fail(e.message)
                }
            this@Narrator.engine = engine
            chunks = speechChunks(article.paragraphs, engine.maxChunkChars)
            if (chunks.isEmpty()) return@launch stop()
            offsets =
                chunks.runningFold(0) { total, chunk -> total + chunk.text.length }.toIntArray()
            // A tap while the engine was getting ready still counts.
            val wanted = _state.value ?: return@launch
            startAt(firstChunkOf(wanted.paragraph), play = player.playWhenReady)
        }
    }

    fun togglePlaying() {
        if (player.playWhenReady) player.pause() else player.play()
    }

    fun skipParagraphs(delta: Int) {
        val current = _state.value ?: return
        if (chunks.isEmpty()) return
        seekToParagraph((current.paragraph + delta).coerceIn(0, chunks.last().paragraph))
    }

    fun seekToParagraph(paragraph: Int) {
        // Back into the article that ended: stay with it.
        continuation?.cancel()
        continuation = null
        if (chunks.isEmpty()) {
            // Still getting the engine ready: start there instead.
            _state.value = _state.value?.copy(paragraph = paragraph)
            return
        }
        val chunk = firstChunkOf(paragraph)
        val item = itemOf(chunk)
        if (item != null) player.seekTo(item, 0) else startAt(chunk, play = player.playWhenReady)
    }

    fun setSpeed(speed: Float) {
        this.speed = speed
        player.setPlaybackSpeed(speed)
    }

    fun stop() {
        reset()
        player.stop()
        player.clearMediaItems()
        dir.deleteRecursively()
        _state.value = null
        session?.let(MediaController::releaseFuture)
        session = null
    }

    /** Forgets the article; what's in the player is the caller's to replace. */
    private fun reset() {
        preparing?.cancel()
        preparing = null
        continuation?.cancel()
        continuation = null
        feeding?.cancel()
        feeding = null
        article = null
        engine = null
        chunks = emptyList()
    }

    private fun fail(message: String?) {
        stop()
        _errors.tryEmit(message ?: "Couldn't read this article aloud.")
    }

    private fun firstChunkOf(paragraph: Int): Int =
        chunks.indexOfFirst { it.paragraph >= paragraph }.takeIf { it >= 0 } ?: 0

    /** The playlist index of [chunk], if it's there. */
    private fun itemOf(chunk: Int): Int? =
        (0 until player.mediaItemCount).firstOrNull {
            player.getMediaItemAt(it).mediaId == "$chunk"
        }

    private fun startAt(chunk: Int, play: Boolean) {
        val engine = engine ?: return
        val article = article ?: return
        feeding?.cancel()
        playSilence(article)
        dir.deleteRecursively()
        dir.mkdirs()
        playingChunk.value = chunk
        fed = false
        lastAdded = null
        player.setPlaybackSpeed(speed)
        player.playWhenReady = play
        publish(chunk)
        feeding = scope.launch {
            try {
                feed(chunk, engine)
            } catch (e: SpeechUnavailable) {
                // Not if a seek or another article replaced this feed meanwhile.
                if (isActive) fail(e.message)
            }
        }
    }

    /**
     * Whether [chunk] is close enough to what's playing to synthesize now. Always, when nothing is
     * queued past what's playing (skipped chunks can leave a gap wider than the lookahead, and the
     * player would sit at the end of the queue waiting).
     */
    private fun wanted(chunk: Int, engine: SpeechEngine): Boolean {
        val next = playingChunk.value + 1
        return chunk <= next ||
            (lastAdded ?: -1) <= playingChunk.value ||
            offsets[chunk] - offsets[next] <= engine.lookaheadChars
    }

    private suspend fun feed(from: Int, engine: SpeechEngine) = coroutineScope {
        val article = article ?: return@coroutineScope
        val inFlight = ArrayDeque<Pair<Int, Deferred<File?>>>()
        var next = from
        while (next < chunks.size || inFlight.isNotEmpty()) {
            while (
                next < chunks.size && inFlight.size < engine.parallelism && wanted(next, engine)
            ) {
                val index = next++
                inFlight.addLast(index to async { synthesizeOrSkip(engine, index) })
            }
            if (inFlight.isEmpty()) {
                playingChunk.first { wanted(next, engine) }
                continue
            }
            val (index, result) = inFlight.removeFirst()
            val file = result.await() ?: continue
            val item = item(article, index, file)
            if (onSilence()) player.setMediaItems(listOf(item)) else player.addMediaItem(item)
            lastAdded = index
            when (player.playbackState) {
                Player.STATE_IDLE -> player.prepare()
                // It caught up with the synthesis; carry on with the new chunk.
                Player.STATE_ENDED -> player.seekTo(player.mediaItemCount - 1, 0)
                else -> {}
            }
            updateWaiting()
        }
        fed = true
        if (lastAdded == null)
            fail("Couldn't read this article aloud. Check the voice in Settings.")
        else stopIfFinished()
    }

    /** The chunk's audio, or null to skip it; [SpeechUnavailable] ends the narration. */
    private suspend fun synthesizeOrSkip(engine: SpeechEngine, index: Int): File? =
        try {
            engine.synthesize(chunks[index].text, dir, "$index")
        } catch (e: CancellationException) {
            throw e
        } catch (e: SpeechUnavailable) {
            throw e
        } catch (_: Exception) {
            null
        }

    /** Stops once the last chunk there'll ever be has played. */
    private fun stopIfFinished() {
        val current = player.currentMediaItem?.mediaId?.toIntOrNull()
        if (fed && player.playbackState == Player.STATE_ENDED && current == lastAdded) finished()
    }

    /** The article ended: go on to the next one, if there is one, or stop. */
    private fun finished() {
        val done = article ?: return
        feeding = null
        continuation?.cancel()
        playSilence(done)
        _state.value = _state.value?.copy(waiting = true)
        continuation = scope.launch {
            val following =
                try {
                    next(done)
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    null
                }
            // Unless the user started or stopped something meanwhile.
            if (article !== done) return@launch
            // Paused meanwhile: the next article starts paused.
            if (following == null) stop() else narrate(following, play = player.playWhenReady)
        }
    }

    /** Replaces the playlist with silence, for while there's no audio yet (see the class docs). */
    // Media sources are "unstable" API, but SilenceMediaSource has been there since ExoPlayer 2.
    @OptIn(UnstableApi::class)
    private fun playSilence(article: NarratedArticle) {
        player.setMediaSource(
            SilenceMediaSource(SILENCE_US).apply {
                updateMediaItem(
                    MediaItem.Builder()
                        .setMediaId(SILENCE_ID)
                        .setMediaMetadata(metadata(article))
                        .build()
                )
            }
        )
        player.prepare()
    }

    private fun onSilence(): Boolean = player.currentMediaItem?.mediaId == SILENCE_ID

    private fun item(article: NarratedArticle, chunk: Int, file: File) =
        MediaItem.Builder()
            .setMediaId("$chunk")
            .setUri(Uri.fromFile(file))
            .setMediaMetadata(metadata(article))
            .build()

    private fun metadata(article: NarratedArticle) =
        MediaMetadata.Builder()
            .setTitle(article.title)
            .setArtist(article.source)
            .setAlbumTitle("Lion Reader")
            .build()

    private fun publish(chunk: Int) {
        val article = article ?: return
        _state.value =
            NarrationState(
                article.entryId,
                article.title,
                chunks[chunk].paragraph,
                player.playWhenReady,
                waiting(),
                article.queue,
            )
    }

    /**
     * No audio to play yet: nothing queued, still buffering, idle after an error until the feed
     * brings the next chunk, or caught up with the synthesis.
     */
    private fun waiting(): Boolean =
        engine == null ||
            onSilence() ||
            player.mediaItemCount == 0 ||
            player.playbackState == Player.STATE_BUFFERING ||
            player.playbackState == Player.STATE_IDLE ||
            (player.playbackState == Player.STATE_ENDED && !fed)

    private fun updateWaiting() {
        _state.value = _state.value?.copy(waiting = waiting())
    }

    private val listener =
        object : Player.Listener {
            override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
                val chunk = mediaItem?.mediaId?.toIntOrNull() ?: return
                playingChunk.value = chunk
                publish(chunk)
                // Drop what's well behind, so skipping back a little stays instant.
                // Only our own files: an engine's cache stays.
                while (player.currentMediaItemIndex > KEEP_BEHIND) {
                    val file = player.getMediaItemAt(0).localConfiguration?.uri?.path?.let(::File)
                    if (file?.parentFile == dir) file.delete()
                    player.removeMediaItem(0)
                }
            }

            override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
                _state.value = _state.value?.copy(playing = playWhenReady, waiting = waiting())
            }

            override fun onPlaybackStateChanged(playbackState: Int) {
                updateWaiting()
                stopIfFinished()
            }

            // A file the player can't play (an odd one from some engine): move
            // past it rather than sit on it.
            override fun onPlayerError(error: PlaybackException) {
                if (player.hasNextMediaItem()) {
                    player.seekToNextMediaItem()
                    player.prepare()
                } else if (fed) {
                    fail("Couldn't play this article's narration.")
                }
            }
        }

    private companion object {
        const val KEEP_BEHIND = 5
        const val SILENCE_ID = "silence"
        /** Longer than any wait for audio; if it runs out, the player just sits ended. */
        const val SILENCE_US = 30L * 60 * 1_000_000
    }
}
