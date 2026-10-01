package com.lionreader.app.narration

import android.content.ComponentName
import android.content.Context
import android.net.Uri
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
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
)

/**
 * Narration is on while there is a state: the article it's on, the paragraph being spoken, and
 * whether it's playing or paused. [waiting]: it should be playing but has no audio yet (the
 * article's text hasn't been supplied, the engine is getting ready, or the next chunk is still
 * being synthesized).
 */
data class NarrationState(
    val entryId: String,
    val title: String,
    val paragraph: Int,
    val playing: Boolean,
    val waiting: Boolean = false,
)

/**
 * Narrates one article at a time with the [SpeechEngine] the settings pick: synthesizes it chunk by
 * chunk a little ahead of the player and plays the chunks through one ExoPlayer, which
 * [NarrationService] exposes as a media session (notification, lock screen, headset buttons,
 * background playback). Played chunks are dropped, so the files on disk stay a handful however long
 * the article. A chunk the engine can't say is skipped, so the playlist can have gaps: items are
 * found by their chunk index (the media id).
 *
 * Main thread only (ExoPlayer's rule).
 */
class Narrator(
    private val context: Context,
    private val settings: () -> AppSettings,
    private val engineFor: suspend (AppSettings) -> SpeechEngine,
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
    private var feeding: Job? = null
    /** Whether the feed has synthesized everything it's going to, and the last chunk it added. */
    private var fed = false
    private var lastAdded: Int? = null
    private var session: ListenableFuture<MediaController>? = null

    /** Turns narration on, playing [article] from [fromParagraph]. */
    fun narrate(article: NarratedArticle, fromParagraph: Int = 0) {
        reset()
        _state.value =
            NarrationState(
                article.entryId,
                article.title,
                fromParagraph,
                playing = true,
                waiting = true,
            )
        load(article)
    }

    /**
     * Moves narration to another article, playing or paused as it was: what's playing stops at
     * once, and the new article's audio waits for [supply]. Nothing while narration is off; on the
     * same article, only takes the [title].
     */
    fun follow(entryId: String, title: String) {
        val current = _state.value ?: return
        if (current.entryId == entryId) {
            if (article == null) _state.value = current.copy(title = title)
            return
        }
        reset()
        _state.value = NarrationState(entryId, title, 0, current.playing, waiting = current.playing)
    }

    /**
     * The text of the article narration [follow]ed to. Its audio is only prepared once it's to
     * play, so a paused narration doesn't synthesize (and with cloud voices, pay for) each article
     * it follows. An article with nothing to say leaves narration on, for the next.
     */
    fun supply(article: NarratedArticle) {
        val current = _state.value ?: return
        if (current.entryId != article.entryId || this.article != null) return
        if (article.paragraphs.isEmpty()) {
            _state.value = current.copy(title = article.title, waiting = false)
            return
        }
        _state.value = current.copy(title = article.title)
        if (current.playing) load(article) else this.article = article
    }

    /** Gets [article]'s audio ready, starting from the state's paragraph if it's playing. */
    private fun load(article: NarratedArticle) {
        this.article = article
        speed = settings().narrationSpeed
        // Binding a controller starts the service, which puts the player in a
        // media session and keeps playback going in the background. Kept from
        // one article to the next, so the notification doesn't flicker.
        if (session == null) {
            session =
                MediaController.Builder(
                        context,
                        SessionToken(context, ComponentName(context, NarrationService::class.java)),
                    )
                    .buildAsync()
        }
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
            // A tap or pause while the engine was getting ready still counts.
            val wanted = _state.value ?: return@launch
            startAt(firstChunkOf(wanted.paragraph), play = wanted.playing)
        }
    }

    fun togglePlaying() {
        if (engine == null) {
            val current = _state.value ?: return
            val playing = !current.playing
            _state.value = current.copy(playing = playing, waiting = playing)
            if (playing) loadPending()
            return
        }
        if (player.playWhenReady) player.pause() else player.play()
    }

    /** An article supplied while paused gets its audio once it's to play. */
    private fun loadPending() {
        val pending = article ?: return
        if (engine == null && preparing?.isActive != true) load(pending)
    }

    fun skipParagraphs(delta: Int) {
        val current = _state.value ?: return
        if (chunks.isEmpty()) return
        seekToParagraph((current.paragraph + delta).coerceIn(0, chunks.last().paragraph))
    }

    fun seekToParagraph(paragraph: Int) {
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
        _state.value = null
        session?.let(MediaController::releaseFuture)
        session = null
    }

    /** Stops what's playing and forgets the article, keeping the media session. */
    private fun reset() {
        preparing?.cancel()
        preparing = null
        feeding?.cancel()
        feeding = null
        player.stop()
        player.clearMediaItems()
        dir.deleteRecursively()
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
        feeding?.cancel()
        player.stop()
        player.clearMediaItems()
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
            player.addMediaItem(item(article, index, file))
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
        if (fed && player.playbackState == Player.STATE_ENDED && current == lastAdded) stop()
    }

    private fun item(article: NarratedArticle, chunk: Int, file: File) =
        MediaItem.Builder()
            .setMediaId("$chunk")
            .setUri(Uri.fromFile(file))
            .setMediaMetadata(
                MediaMetadata.Builder()
                    .setTitle(article.title)
                    .setArtist(article.source)
                    .setAlbumTitle("Lion Reader")
                    .build()
            )
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
            )
    }

    /**
     * No audio to play yet: nothing queued, still buffering, idle after an error until the feed
     * brings the next chunk, or caught up with the synthesis.
     */
    private fun waiting(): Boolean =
        engine == null ||
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
                // Play from the notification or a headset, before the audio was prepared.
                if (playWhenReady) loadPending()
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
    }
}
