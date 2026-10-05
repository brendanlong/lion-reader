package com.lionreader.app.narration

import android.content.ComponentName
import android.content.Context
import android.net.Uri
import android.os.SystemClock
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.lionreader.shared.narration.NarratedArticle
import com.lionreader.shared.narration.NarrationState
import com.lionreader.shared.narration.PlaybackState
import com.lionreader.shared.narration.PlayerSnapshot
import com.lionreader.shared.narration.SpeechChunk
import com.lionreader.shared.narration.SpeechInterrupted
import com.lionreader.shared.narration.SpeechUnavailable
import com.lionreader.shared.narration.derive
import com.lionreader.shared.narration.finished
import com.lionreader.shared.narration.isSpeakable
import com.lionreader.shared.narration.paragraphAfter
import com.lionreader.shared.narration.shouldSynthesize
import com.lionreader.shared.narration.speechChunks
import com.lionreader.shared.narration.spokenParagraphs
import com.lionreader.shared.settings.AppSettings
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Narrates one article at a time with the [SpeechEngine] the settings pick: synthesizes it chunk by
 * chunk a little ahead of the player and plays the chunks through one ExoPlayer, which
 * [NarrationService] exposes as a media session (notification, lock screen, headset buttons,
 * background playback). Played chunks are dropped, so the files on disk stay a handful however long
 * the article. A chunk the engine can't say is skipped, so the playlist can have gaps: items are
 * found by their chunk index (the media id).
 *
 * Main thread only (ExoPlayer's rule). Its coroutines run on [Dispatchers.Main], not
 * `Main.immediate`, so that publishing a state never runs one there and then: a waiter woken in the
 * middle of a command would act on what the command hasn't finished changing.
 */
class Narrator(
    private val context: Context,
    private val settings: StateFlow<AppSettings>,
    private val engineFor: suspend (AppSettings) -> SpeechEngine,
    /**
     * Binds a controller, which starts [NarrationService]: it puts the player in a media session
     * and keeps playback going in the background. Returns the unbinding.
     */
    private val connectSession: () -> () -> Unit = {
        val controller =
            MediaController.Builder(
                    context,
                    SessionToken(context, ComponentName(context, NarrationService::class.java)),
                )
                .buildAsync()
        ({ MediaController.releaseFuture(controller) })
    },
    /** How long the player can run dry, the engine unreachable, before narration pauses. */
    private val pauseAfterMillis: Long = 60_000,
    private val now: () -> Long = SystemClock::elapsedRealtime,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val dir = File(context.cacheDir, "narration")

    private val _state = MutableStateFlow<NarrationState?>(null)
    val state: StateFlow<NarrationState?> = _state.asStateFlow()

    private val _notice = MutableStateFlow<String?>(null)

    /**
     * Why narration stopped or paused on its own, for the user: kept until shown (it's often in the
     * background, with nothing to show it), and dropped once narration goes on.
     */
    val notice: StateFlow<String?> = _notice.asStateFlow()

    fun noticeShown(message: String) {
        _notice.compareAndSet(message, null)
    }

    /**
     * Counts the engine answering, so attempts waiting out a dropped connection try again at once.
     */
    private val reached = MutableStateFlow(0L)

    private val playerInstance = lazy { buildPlayer() }
    val player: ExoPlayer by playerInstance

    init {
        scope.launch {
            settings
                .map { it.narrationSpeed }
                .distinctUntilChanged()
                .collect { if (playerInstance.isInitialized()) player.setPlaybackSpeed(it) }
        }
    }

    @OptIn(UnstableApi::class)
    private fun buildPlayer(): ExoPlayer =
        ExoPlayer.Builder(context)
            // Reads streamed chunks as they arrive (StreamedAudio), and files.
            .setMediaSourceFactory(
                DefaultMediaSourceFactory(NarrationDataSource.Factory())
                    .setLoadErrorHandlingPolicy(NarrationLoadErrorPolicy())
            )
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

    /** What the narrator has of the article it's on; replaced whole when it moves on. */
    private var current: Current = Current.Awaiting
    private val playingChunk = MutableStateFlow(0)
    /**
     * Unbinds the media session; kept from one article to the next, so the notification doesn't
     * flicker.
     */
    private var session: (() -> Unit)? = null
    /**
     * The article narration last followed away from, and where it was, to resume on coming back.
     */
    private var left: Pair<String, Int>? = null

    private sealed interface Current {
        /** Followed to; its text isn't supplied yet. */
        data object Awaiting : Current

        /** Supplied with nothing to say. */
        data object Silent : Current

        /** The article; its audio is prepared once it's to play. */
        class Article(val article: NarratedArticle) : Current {
            var preparing: Job? = null
            /** Once the engine is ready. */
            var prepared: Prepared? = null
            var feed: Feed? = null

            fun cancel() {
                preparing?.cancel()
                feed?.job?.cancel()
            }
        }
    }

    /** The article in the engine's chunks. */
    private class Prepared(val engine: SpeechEngine, val chunks: List<SpeechChunk>) {
        /** Characters before each chunk, for measuring how far ahead synthesis is. */
        val offsets: IntArray =
            chunks.runningFold(0) { total, chunk -> total + chunk.text.length }.toIntArray()

        /** Or of the next paragraph with something to say; past the last one, the last one's. */
        fun firstChunkOf(paragraph: Int): Int {
            val spoken = minOf(paragraph, chunks.last().paragraph)
            return chunks.indexOfFirst { it.paragraph >= spoken }
        }
    }

    /** Synthesis from one chunk on; a seek starts another. */
    private class Feed {
        var job: Job? = null
        val starved = Starved()
        /** Whether it has synthesized everything it's going to, and the last chunk it added. */
        var fed = false
        var lastAdded: Int? = null
        /** Times each chunk has been said again after stopping partway (see [replay]). */
        val replays = mutableMapOf<Int, Int>()
    }

    /** The article narration is on, once its text is supplied. */
    private val onArticle: Current.Article?
        get() = current as? Current.Article

    private val prepared: Prepared?
        get() = onArticle?.prepared

    /** Since when the player has run dry with the engine unreachable. */
    private class Starved {
        var since: Long? = null
    }

    /** Turns narration on, playing [article] from [fromParagraph]. */
    fun narrate(article: NarratedArticle, fromParagraph: Int = 0) {
        reset()
        _notice.value = null
        val audio = Current.Article(article).also { current = it }
        publish(NarrationState(article.entryId, article.title, fromParagraph, playing = true))
        prepare(audio)
    }

    /**
     * Moves narration to another article, playing or paused as it was: what's playing stops at
     * once, and the new article's audio waits for [supply]. Nothing while narration is off; on the
     * same article, only takes the [title].
     */
    fun follow(entryId: String, title: String) {
        val state = _state.value ?: return
        if (state.entryId == entryId) {
            if (current == Current.Awaiting) publish(state.copy(title = title))
            return
        }
        val resume = left?.takeIf { it.first == entryId }?.second
        // An article passed through without a place doesn't replace the one remembered.
        state.paragraph?.let { left = state.entryId to it }
        reset()
        publish(NarrationState(entryId, title, resume, state.playing))
    }

    /**
     * The text of the article narration [follow]ed to. Its audio is only prepared once it's to
     * play, so a paused narration doesn't synthesize (and with cloud voices, pay for) each article
     * it follows. An article with nothing to say leaves narration on, for the next.
     */
    fun supply(article: NarratedArticle) {
        val state = _state.value ?: return
        if (state.entryId != article.entryId || current != Current.Awaiting) return
        if (article.paragraphs.none(::isSpeakable)) {
            current = Current.Silent
            publish(state.copy(title = article.title))
            return
        }
        val supplied = Current.Article(article)
        current = supplied
        if (state.playing) {
            publish(state.copy(title = article.title, paragraph = state.paragraph ?: 0))
            prepare(supplied)
        } else {
            // No place in it (so no highlight to scroll the page to) until it plays.
            publish(state.copy(title = article.title))
        }
    }

    /** Gets [audio]'s engine and chunks ready, then starts from the state's paragraph. */
    private fun prepare(audio: Current.Article) {
        if (session == null) session = connectSession()
        audio.preparing = scope.launch {
            val engine =
                try {
                    reaching(Starved()) { engineFor(settings.value) }
                } catch (e: SpeechUnavailable) {
                    return@launch fail(e.message)
                }
            // Narration moved on meanwhile (and this should have been cancelled).
            if (current !== audio) return@launch
            val prepared =
                Prepared(engine, speechChunks(audio.article.paragraphs, engine.maxChunkChars))
            if (prepared.chunks.isEmpty()) return@launch stop()
            audio.prepared = prepared
            // A tap or pause while the engine was getting ready still counts.
            val wanted = _state.value ?: return@launch
            startAt(audio, prepared.firstChunkOf(wanted.paragraph ?: 0), play = wanted.playing)
        }
    }

    /**
     * "Listen" on a selection in [article]: narration from [paragraph], or, already on it, goes
     * there and plays.
     */
    fun listenFrom(article: NarratedArticle, paragraph: Int) {
        if (_state.value?.entryId != article.entryId) return narrate(article, paragraph)
        // Followed here but not supplied yet: the selection's page has the text.
        supply(article)
        seekToParagraph(paragraph)
        play()
    }

    private fun play() {
        if (prepared != null) player.play() else if (_state.value?.playing == false) togglePlaying()
    }

    fun togglePlaying() {
        if (prepared == null) {
            val state = _state.value ?: return
            val playing = !state.playing
            // Supplied while paused: its audio is prepared now. Only from the app: with the
            // player empty, media3 hides the notification and doesn't pass a headset's play on.
            val pending = onArticle?.takeIf { playing && it.preparing?.isActive != true }
            publish(state.copy(playing = playing))
            if (playing) _notice.value = null
            pending?.let(::prepare)
            return
        }
        if (player.playWhenReady) player.pause() else player.play()
    }

    /**
     * Moves [delta] paragraphs; nothing past either end (the controls offer nothing there, but a
     * headset button can still come in).
     */
    fun skipParagraphs(delta: Int) {
        val state = _state.value ?: return
        spoken()?.let { paragraphAfter(it, state.paragraph, delta) }?.let(::seekToParagraph)
    }

    private fun spoken(): List<Int>? =
        spokenParagraphs(onArticle?.prepared?.chunks, onArticle?.article?.paragraphs)

    fun seekToParagraph(paragraph: Int) {
        val prepared = prepared
        if (prepared == null) {
            // Not ready to play yet: start there instead.
            publish(_state.value?.copy(paragraph = paragraph))
            return
        }
        val chunk = prepared.firstChunkOf(paragraph)
        val item = itemOf(chunk)
        if (item != null) player.seekTo(item, 0)
        else onArticle?.let { startAt(it, chunk, play = player.playWhenReady) }
    }

    /**
     * The player ended only because synthesis hasn't caught up: the feed carries on with the next
     * chunk when it lands, so "play" mustn't start the last one over.
     */
    fun awaitingSynthesis(): Boolean = onArticle?.feed?.fed == false

    fun stop() {
        reset()
        publish(null)
        _notice.value = null
        left = null
        session?.invoke()
        session = null
    }

    /** Stops what's playing and forgets the article, keeping the media session. */
    private fun reset() {
        onArticle?.cancel()
        current = Current.Awaiting
        player.stop()
        player.clearMediaItems()
        dir.deleteRecursively()
    }

    private fun fail(message: String?) {
        stop()
        _notice.value = message ?: "Couldn't read this article aloud."
    }

    /** The playlist index of [chunk], if it's there. */
    private fun itemOf(chunk: Int): Int? =
        (0 until player.mediaItemCount).firstOrNull {
            player.getMediaItemAt(it).mediaId == "$chunk"
        }

    private fun startAt(audio: Current.Article, chunk: Int, play: Boolean) {
        val prepared = audio.prepared ?: return
        audio.feed?.job?.cancel()
        player.stop()
        player.clearMediaItems()
        dir.deleteRecursively()
        dir.mkdirs()
        playingChunk.value = chunk
        val feed = Feed()
        audio.feed = feed
        player.setPlaybackSpeed(settings.value.narrationSpeed)
        player.playWhenReady = play
        publishAt(chunk)
        feed.job = scope.launch {
            try {
                feed(feed, audio.article, prepared, chunk)
            } catch (e: SpeechUnavailable) {
                // Not if a seek or another article replaced this feed meanwhile.
                if (isActive) fail(e.message)
            }
        }
    }

    private fun wanted(chunk: Int, prepared: Prepared, feed: Feed): Boolean =
        shouldSynthesize(
            chunk,
            playingChunk.value,
            feed.lastAdded,
            prepared.offsets,
            prepared.engine.lookaheadChars,
            settings.value.narrationSpeed,
        )

    private suspend fun feed(
        feed: Feed,
        article: NarratedArticle,
        prepared: Prepared,
        from: Int,
    ) = coroutineScope {
        val engine = prepared.engine
        val chunks = prepared.chunks
        val inFlight = ArrayDeque<Pair<Int, Deferred<Uri?>>>()
        var next = from
        while (next < chunks.size || inFlight.isNotEmpty()) {
            while (
                next < chunks.size &&
                    inFlight.size < engine.parallelism &&
                    wanted(next, prepared, feed)
            ) {
                val index = next++
                inFlight.addLast(index to async { synthesizeOrSkip(feed, prepared, index) })
            }
            if (inFlight.isEmpty()) {
                // A faster speed reaches further ahead, so it's asked again on either changing.
                combine(playingChunk, settings) { _, _ -> }.first { wanted(next, prepared, feed) }
                continue
            }
            val (index, result) = inFlight.removeFirst()
            val audio = result.await() ?: continue
            player.addMediaItem(item(article, index, audio))
            feed.lastAdded = index
            when (player.playbackState) {
                Player.STATE_IDLE -> player.prepare()
                // It caught up with the synthesis; carry on with the new chunk.
                Player.STATE_ENDED -> player.seekTo(player.mediaItemCount - 1, 0)
                else -> {}
            }
            publish(_state.value)
        }
        feed.fed = true
        if (feed.lastAdded == null)
            fail("Couldn't read this article aloud. Check the voice in Settings.")
        else stopIfFinished()
    }

    /**
     * The chunk's audio, or null to skip it; [SpeechUnavailable] ends the narration. While the
     * engine can't be reached, what's queued plays on and this tries again ([reaching]): a dropped
     * connection in the background doesn't end narration mid-word.
     */
    private suspend fun synthesizeOrSkip(feed: Feed, prepared: Prepared, index: Int): Uri? {
        return try {
            reaching(feed.starved) {
                prepared.engine.synthesize(prepared.chunks[index].text, dir, "$index")
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: SpeechUnavailable) {
            throw e
        } catch (_: Exception) {
            null
        }
    }

    /**
     * [attempt] until the engine answers. While it can't be reached ([SpeechInterrupted]) this
     * backs off and tries again; at once when another attempt gets through, and from the start when
     * narration is played again after a pause.
     */
    private suspend fun <T : Any> reaching(starved: Starved, attempt: suspend () -> T): T {
        var wait = RETRY_FIRST_MILLIS
        while (true) {
            val seen = reached.value
            try {
                return attempt().also {
                    starved.since = null
                    reached.update { it + 1 }
                }
            } catch (e: SpeechInterrupted) {
                interrupted(starved, e)
            }
            val woke =
                withTimeoutOrNull(wait) {
                    combine(_state, reached) { state, count ->
                            state?.playing == false || count != seen
                        }
                        .first { it }
                }
            if (woke == null) {
                wait = (wait * 2).coerceAtMost(RETRY_MAX_MILLIS)
            } else {
                // Paused (by the user, or below): try again once it's played again.
                _state.first { it == null || it.playing }
                wait = RETRY_FIRST_MILLIS
            }
        }
    }

    /**
     * The engine couldn't be reached. Once the player has run dry for [pauseAfterMillis] that way,
     * narration pauses, keeping its place, rather than spin; playing again tries again.
     */
    private fun interrupted(starved: Starved, error: SpeechInterrupted) {
        val state = _state.value
        if (state == null || !state.playing || !derived(state).waiting) {
            starved.since = null
            return
        }
        val since = starved.since ?: now().also { starved.since = it }
        if (now() - since < pauseAfterMillis) return
        starved.since = null
        // Before the audio's prepared the player may not be playing yet: pause the narration.
        if (prepared == null) publish(state.copy(playing = false)) else player.pause()
        _notice.value = "Narration paused: ${error.message}"
    }

    /** Stops once the last chunk there'll ever be has played. */
    private fun stopIfFinished() {
        val feed = onArticle?.feed ?: return
        if (finished(snapshot(), feed.fed, feed.lastAdded)) stop()
    }

    private fun item(article: NarratedArticle, chunk: Int, audio: Uri) =
        MediaItem.Builder()
            .setMediaId("$chunk")
            .setUri(audio)
            .setMediaMetadata(
                MediaMetadata.Builder()
                    .setTitle(article.title)
                    .setArtist(article.source)
                    .setAlbumTitle("Lion Reader")
                    .build()
            )
            .build()

    /** Publishes [chunk] as the place in the article. */
    private fun publishAt(chunk: Int) {
        val audio = onArticle ?: return
        val prepared = audio.prepared ?: return
        publish(
            NarrationState(
                audio.article.entryId,
                audio.article.title,
                prepared.chunks[chunk].paragraph,
                player.playWhenReady,
            )
        )
    }

    /**
     * The one way the state is set: with what's [derive]d from it and the narrator's article, so
     * that can't go stale. Publish again whenever what it's derived from changes.
     */
    private fun publish(state: NarrationState?) {
        _state.value = state?.let(::derived)
    }

    private fun derived(state: NarrationState): NarrationState {
        val audio = onArticle
        return derive(
            state,
            spoken(),
            silent = current == Current.Silent,
            player = audio?.prepared?.let { snapshot() },
            fed = audio?.feed?.fed == true,
        )
    }

    private fun snapshot() =
        PlayerSnapshot(
            when (player.playbackState) {
                Player.STATE_BUFFERING -> PlaybackState.BUFFERING
                Player.STATE_READY -> PlaybackState.READY
                Player.STATE_ENDED -> PlaybackState.ENDED
                else -> PlaybackState.IDLE
            },
            player.mediaItemCount,
            player.currentMediaItem?.mediaId?.toIntOrNull(),
        )

    private val listener =
        object : Player.Listener {
            override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
                val chunk = mediaItem?.mediaId?.toIntOrNull() ?: return
                playingChunk.value = chunk
                publishAt(chunk)
                // Drop what's well behind, so skipping back a little stays instant.
                // Only our own files: an engine's cache stays.
                while (player.currentMediaItemIndex > KEEP_BEHIND) {
                    val file = player.getMediaItemAt(0).localConfiguration?.uri?.path?.let(::File)
                    if (file?.parentFile == dir) file.delete()
                    player.removeMediaItem(0)
                }
            }

            override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
                publish(_state.value?.copy(playing = playWhenReady))
                // Going on: what paused it is past.
                if (playWhenReady) _notice.value = null
            }

            override fun onPlaybackStateChanged(playbackState: Int) {
                publish(_state.value)
                stopIfFinished()
            }

            override fun onPlayerError(error: PlaybackException) {
                val chunk = player.currentMediaItem?.mediaId?.toIntOrNull()
                if (chunk != null && error.causes().any { it is SpeechStreamBroken }) {
                    replay(chunk)
                    return
                }
                // A file the player can't play (an odd one from some engine): move
                // past it rather than sit on it.
                if (player.hasNextMediaItem()) {
                    player.seekToNextMediaItem()
                    player.prepare()
                } else if (onArticle?.feed?.fed == true) {
                    fail("Couldn't play this article's narration.")
                }
            }
        }

    /**
     * [chunk]'s audio stopped partway ([SpeechStreamBroken]): synthesizes it again and plays it
     * from its start, or moves past it if it can't be said or has stopped partway too often. The
     * player waits, idle, meanwhile.
     */
    private fun replay(chunk: Int) {
        val audio = onArticle ?: return
        val prepared = audio.prepared ?: return
        val feed = audio.feed ?: return
        // Each is paid for: one that keeps breaking is skipped, as the web does.
        val replays = feed.replays.merge(chunk, 1, Int::plus)!!
        scope.launch {
            val again =
                try {
                    if (replays > MAX_REPLAYS) null else synthesizeOrSkip(feed, prepared, chunk)
                } catch (e: SpeechUnavailable) {
                    if (onArticle?.feed === feed) fail(e.message)
                    return@launch
                }
            // Not if a seek or another article replaced this feed meanwhile.
            if (onArticle?.feed !== feed) return@launch
            val index =
                (0 until player.mediaItemCount).firstOrNull {
                    player.getMediaItemAt(it).mediaId == "$chunk"
                } ?: return@launch
            if (again == null) {
                player.removeMediaItem(index)
                if (index >= player.mediaItemCount) {
                    if (feed.fed) stopIfFinished()
                    return@launch
                }
            } else {
                player.replaceMediaItem(index, item(audio.article, chunk, again))
            }
            player.seekTo(index, 0)
            player.prepare()
        }
    }

    private fun Throwable.causes(): Sequence<Throwable> = generateSequence(this) { it.cause }

    private companion object {
        const val KEEP_BEHIND = 5
        const val MAX_REPLAYS = 2
        const val RETRY_FIRST_MILLIS = 2_000L
        const val RETRY_MAX_MILLIS = 30_000L
    }
}
