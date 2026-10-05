package com.lionreader.shared.narration

// The narrator's decisions, apart from the player and the coroutines they steer, so each
// platform's narrator makes the same ones.

/** A player's state, as media players have them (ExoPlayer's `STATE_*`). */
enum class PlaybackState {
    /** Nothing prepared, or stopped after an error. */
    IDLE,
    BUFFERING,
    READY,
    ENDED,
}

/** What the narrator goes by of the player: its state, how many chunks it has, and which plays. */
data class PlayerSnapshot(val playbackState: PlaybackState, val itemCount: Int, val chunk: Int?)

/**
 * The paragraphs with something to say: the [chunks]', or before the audio is prepared, the
 * article's [paragraphs]. Null with no article.
 */
fun spokenParagraphs(chunks: List<SpeechChunk>?, paragraphs: List<String>?): List<Int>? =
    chunks?.map { it.paragraph }?.distinct()
        ?: paragraphs?.withIndex()?.filter { isSpeakable(it.value) }?.map { it.index }

/**
 * The paragraph of [spoken] [delta] paragraphs from [from], or null past either end. With no place
 * yet ([from] null), "next" is the first paragraph.
 */
fun paragraphAfter(spoken: List<Int>, from: Int?, delta: Int): Int? {
    val at = from ?: -1
    return if (delta > 0) spoken.filter { it > at }.getOrNull(delta - 1)
    else spoken.filter { it < at }.let { it.getOrNull(it.size + delta) }
}

/**
 * Whether narration has no audio to play yet. Before its audio is prepared ([player] null): while
 * it's to play, unless the article has nothing to say ([silent]). After: nothing queued, still
 * buffering, idle after an error until the feed brings the next chunk, or caught up with the
 * synthesis before the feed has added all it will ([fed]).
 */
fun isWaiting(
    playing: Boolean,
    silent: Boolean,
    player: PlayerSnapshot?,
    fed: Boolean,
): Boolean =
    if (player == null) {
        playing && !silent
    } else {
        player.itemCount == 0 ||
            player.playbackState == PlaybackState.BUFFERING ||
            player.playbackState == PlaybackState.IDLE ||
            (player.playbackState == PlaybackState.ENDED && !fed)
    }

/**
 * [state] with what follows from it and the rest: whether it's [waiting][isWaiting], and which ways
 * it can skip among the [spoken] paragraphs.
 */
fun derive(
    state: NarrationState,
    spoken: List<Int>?,
    silent: Boolean,
    player: PlayerSnapshot?,
    fed: Boolean,
): NarrationState =
    state.copy(
        waiting = isWaiting(state.playing, silent, player, fed),
        canSkipBack = spoken != null && paragraphAfter(spoken, state.paragraph, -1) != null,
        canSkipForward = spoken != null && paragraphAfter(spoken, state.paragraph, 1) != null,
    )

/**
 * Whether [chunk] is close enough to the [playing] one to synthesize now: up to the next one, and
 * on within [lookaheadChars] of it at 1x, more at a faster [speed] so the lookahead stays as long
 * in listening time ([offsets]: the characters before each chunk). Always, when nothing is queued
 * past what's playing ([lastAdded]: the last chunk queued): skipped chunks can leave a gap wider
 * than the lookahead, and the player would sit at the end of the queue waiting.
 */
fun shouldSynthesize(
    chunk: Int,
    playing: Int,
    lastAdded: Int?,
    offsets: IntArray,
    lookaheadChars: Int,
    speed: Float,
): Boolean {
    val next = playing + 1
    return chunk <= next ||
        (lastAdded ?: -1) <= playing ||
        offsets[chunk] - offsets[next] <= lookaheadChars * speed
}

/** Whether the last chunk there'll ever be ([lastAdded], once [fed]) has played. */
fun finished(player: PlayerSnapshot, fed: Boolean, lastAdded: Int?): Boolean =
    fed && player.playbackState == PlaybackState.ENDED && player.chunk == lastAdded
