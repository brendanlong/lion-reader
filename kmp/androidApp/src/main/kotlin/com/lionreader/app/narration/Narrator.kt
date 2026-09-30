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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/** What to narrate: an article's paragraphs, as the reader's narration script extracted them. */
data class NarratedArticle(
    val entryId: String,
    val title: String,
    val source: String?,
    val paragraphs: List<String>,
)

/** The article being narrated, the paragraph being spoken, and whether it's playing. */
data class NarrationState(
    val entryId: String,
    val title: String,
    val paragraph: Int,
    val playing: Boolean,
)

/**
 * Narrates one article at a time: synthesizes it chunk by chunk a little ahead of the player and
 * plays the chunks through one ExoPlayer, which [NarrationService] exposes as a media session
 * (notification, lock screen, headset buttons, background playback). Played chunks are dropped, so
 * the files on disk stay a handful however long the article. A chunk the engine can't say is
 * skipped, so the playlist can have gaps: items are found by their chunk index (the media id).
 *
 * Main thread only (ExoPlayer's rule).
 */
class Narrator(private val context: Context, private val settings: () -> AppSettings) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val tts by lazy { SystemTts(context) }
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
    private var chunks: List<SpeechChunk> = emptyList()
    private var speed = 1f
    private val playingChunk = MutableStateFlow(0)
    private var feeding: Job? = null
    /** Whether the feed has synthesized everything it's going to, and the last chunk it added. */
    private var fed = false
    private var lastAdded: Int? = null
    private var session: ListenableFuture<MediaController>? = null

    fun narrate(article: NarratedArticle, fromParagraph: Int = 0) {
        this.article = article
        chunks = speechChunks(article.paragraphs)
        if (chunks.isEmpty()) return stop()
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
        startAt(firstChunkOf(fromParagraph), play = true)
    }

    fun togglePlaying() {
        if (player.playWhenReady) player.pause() else player.play()
    }

    fun skipParagraphs(delta: Int) {
        val current = _state.value ?: return
        seekToParagraph((current.paragraph + delta).coerceIn(0, chunks.last().paragraph))
    }

    fun seekToParagraph(paragraph: Int) {
        if (chunks.isEmpty()) return
        val chunk = firstChunkOf(paragraph)
        val item = itemOf(chunk)
        if (item != null) player.seekTo(item, 0) else startAt(chunk, play = player.playWhenReady)
    }

    fun setSpeed(speed: Float) {
        this.speed = speed
        player.setPlaybackSpeed(speed)
    }

    suspend fun voices(): List<VoiceOption> = tts.voices()

    fun stop() {
        feeding?.cancel()
        feeding = null
        player.stop()
        player.clearMediaItems()
        dir.deleteRecursively()
        article = null
        chunks = emptyList()
        _state.value = null
        session?.let(MediaController::releaseFuture)
        session = null
    }

    private fun firstChunkOf(paragraph: Int): Int =
        chunks.indexOfFirst { it.paragraph >= paragraph }.takeIf { it >= 0 } ?: 0

    /** The playlist index of [chunk], if it's there. */
    private fun itemOf(chunk: Int): Int? =
        (0 until player.mediaItemCount).firstOrNull {
            player.getMediaItemAt(it).mediaId == "$chunk"
        }

    private fun startAt(chunk: Int, play: Boolean) {
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
        feeding = scope.launch { feed(chunk) }
    }

    private suspend fun feed(from: Int) {
        val article = article ?: return
        for (index in from until chunks.size) {
            // Stay a few chunks ahead of what's playing, no further.
            playingChunk.first { index <= it + LOOKAHEAD }
            val file = File(dir, "$index.wav")
            try {
                tts.synthesize(chunks[index].text, settings().narrationVoice, file)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // Skip what the engine can't say rather than stop the article.
                continue
            }
            player.addMediaItem(item(article, index, file))
            lastAdded = index
            when (player.playbackState) {
                Player.STATE_IDLE -> player.prepare()
                // It caught up with the synthesis; carry on with the new chunk.
                Player.STATE_ENDED -> player.seekTo(player.mediaItemCount - 1, 0)
                else -> {}
            }
        }
        fed = true
        if (lastAdded == null) {
            stop()
            _errors.tryEmit("Couldn't read this article aloud. Check the voice in Settings.")
        } else {
            stopIfFinished()
        }
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
            )
    }

    private val listener =
        object : Player.Listener {
            override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
                val chunk = mediaItem?.mediaId?.toIntOrNull() ?: return
                playingChunk.value = chunk
                publish(chunk)
                // Drop what's well behind, so skipping back a little stays instant.
                while (player.currentMediaItemIndex > KEEP_BEHIND) {
                    player.getMediaItemAt(0).localConfiguration?.uri?.path?.let {
                        File(it).delete()
                    }
                    player.removeMediaItem(0)
                }
            }

            override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
                _state.value = _state.value?.copy(playing = playWhenReady)
            }

            override fun onPlaybackStateChanged(playbackState: Int) = stopIfFinished()

            // A file the player can't play (an odd one from some engine): move
            // past it rather than sit on it.
            override fun onPlayerError(error: PlaybackException) {
                if (player.hasNextMediaItem()) {
                    player.seekToNextMediaItem()
                    player.prepare()
                } else if (fed) {
                    stop()
                    _errors.tryEmit("Couldn't play this article's narration.")
                }
            }
        }

    private companion object {
        const val LOOKAHEAD = 3
        const val KEEP_BEHIND = 5
    }
}
