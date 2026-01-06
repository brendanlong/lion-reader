package com.lionreader.service

import android.content.Context
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.common.SimpleBasePlayer
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import java.util.Locale

/**
 * A Media3 Player implementation that wraps Android's TextToSpeech engine.
 *
 * This allows the TTS-based narration to integrate with Media3's MediaSession,
 * providing proper notification and Bluetooth media control support.
 *
 * The player represents paragraphs as a virtual timeline where each paragraph
 * is a fixed duration (for progress tracking purposes).
 */
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class TtsPlayer(
    context: Context,
    looper: Looper,
    private val onParagraphCompleted: () -> Unit,
    private val onParagraphChanged: (Int) -> Unit,
    private val onError: (String) -> Unit,
) : SimpleBasePlayer(looper) {
    companion object {
        // Virtual duration per paragraph in milliseconds (for progress display)
        private const val MS_PER_PARAGRAPH = 30_000L
    }

    private var tts: TextToSpeech? = null
    private var ttsReady = false

    // Playback state
    private var paragraphs: List<String> = emptyList()
    private var currentParagraphIndex = 0
    private var isPlaying = false
    private var currentMediaItem: MediaItem? = null

    init {
        tts =
            TextToSpeech(context) { status ->
                if (status == TextToSpeech.SUCCESS) {
                    tts?.language = Locale.US
                    ttsReady = true
                }
            }

        tts?.setOnUtteranceProgressListener(
            object : UtteranceProgressListener() {
                override fun onDone(utteranceId: String?) {
                    if (isPlaying) {
                        onParagraphCompleted()
                    }
                }

                override fun onError(utteranceId: String?) {
                    onError("TTS error")
                }

                @Deprecated("Deprecated in Java")
                override fun onError(
                    utteranceId: String?,
                    errorCode: Int,
                ) {
                    onError("TTS error: $errorCode")
                }

                override fun onStart(utteranceId: String?) {
                    // Paragraph started speaking
                }
            },
        )
    }

    /**
     * Sets the paragraphs to narrate and metadata for the media item.
     */
    fun setParagraphs(
        paragraphs: List<String>,
        title: String,
        feedTitle: String,
    ) {
        this.paragraphs = paragraphs
        this.currentParagraphIndex = 0
        this.currentMediaItem =
            MediaItem
                .Builder()
                .setMediaMetadata(
                    MediaMetadata
                        .Builder()
                        .setTitle(title)
                        .setArtist(feedTitle)
                        .setMediaType(MediaMetadata.MEDIA_TYPE_NEWS)
                        .build(),
                ).build()
        invalidateState()
    }

    /**
     * Returns the current paragraph index.
     */
    fun getCurrentParagraphIndex(): Int = currentParagraphIndex

    /**
     * Returns the total number of paragraphs.
     */
    fun getTotalParagraphs(): Int = paragraphs.size

    /**
     * Advances to the next paragraph and starts speaking it.
     * Should be called when the previous paragraph completes.
     */
    fun advanceToNextParagraph() {
        if (currentParagraphIndex < paragraphs.size - 1) {
            currentParagraphIndex++
            if (isPlaying) {
                speakCurrentParagraph()
            }
            invalidateState()
        } else {
            // Finished all paragraphs
            isPlaying = false
            invalidateState()
        }
    }

    /**
     * Skips to a specific paragraph index.
     *
     * @param index The paragraph index to skip to
     * @param notifyChange Whether to notify via onParagraphChanged callback (default true).
     *                     Set to false when the service is already aware of the change.
     */
    fun skipToParagraph(
        index: Int,
        notifyChange: Boolean = true,
    ) {
        if (index in paragraphs.indices && index != currentParagraphIndex) {
            tts?.stop()
            currentParagraphIndex = index
            if (isPlaying) {
                speakCurrentParagraph()
            }
            invalidateState()
            if (notifyChange) {
                onParagraphChanged(index)
            }
        }
    }

    private fun speakCurrentParagraph() {
        if (!ttsReady || currentParagraphIndex >= paragraphs.size) return

        val paragraph = paragraphs[currentParagraphIndex]
        tts?.speak(
            paragraph,
            TextToSpeech.QUEUE_FLUSH,
            null,
            "paragraph_$currentParagraphIndex",
        )
    }

    override fun getState(): State {
        val playbackState =
            when {
                paragraphs.isEmpty() -> STATE_IDLE
                !ttsReady -> STATE_IDLE
                else -> STATE_READY
            }

        val availableCommands =
            Player.Commands
                .Builder()
                .addAll(
                    COMMAND_PLAY_PAUSE,
                    COMMAND_STOP,
                    COMMAND_SEEK_TO_NEXT,
                    COMMAND_SEEK_TO_PREVIOUS,
                    COMMAND_GET_CURRENT_MEDIA_ITEM,
                    COMMAND_GET_METADATA,
                ).build()

        val builder =
            State
                .Builder()
                .setAvailableCommands(availableCommands)
                .setPlayWhenReady(isPlaying, PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST)
                .setPlaybackState(playbackState)

        if (currentMediaItem != null && paragraphs.isNotEmpty()) {
            // Create a virtual position based on paragraph index
            val position = currentParagraphIndex * MS_PER_PARAGRAPH
            val duration = paragraphs.size * MS_PER_PARAGRAPH

            // uid parameter identifies this media item
            val mediaItemData =
                MediaItemData
                    .Builder("narration")
                    .apply {
                        setMediaItem(currentMediaItem!!)
                        // Convert milliseconds to microseconds
                        setDurationUs(duration * 1000)
                    }.build()
            builder.setPlaylist(listOf(mediaItemData))
            builder.setCurrentMediaItemIndex(0)
            builder.setContentPositionMs(position)
        }

        return builder.build()
    }

    override fun handleSetPlayWhenReady(playWhenReady: Boolean): ListenableFuture<*> {
        isPlaying = playWhenReady
        if (playWhenReady) {
            speakCurrentParagraph()
        } else {
            tts?.stop()
        }
        return Futures.immediateVoidFuture()
    }

    override fun handleStop(): ListenableFuture<*> {
        isPlaying = false
        tts?.stop()
        paragraphs = emptyList()
        currentParagraphIndex = 0
        currentMediaItem = null
        return Futures.immediateVoidFuture()
    }

    override fun handleSeek(
        mediaItemIndex: Int,
        positionMs: Long,
        seekCommand: Int,
    ): ListenableFuture<*> {
        when (seekCommand) {
            Player.COMMAND_SEEK_TO_NEXT -> {
                if (currentParagraphIndex < paragraphs.size - 1) {
                    skipToParagraph(currentParagraphIndex + 1)
                }
            }
            Player.COMMAND_SEEK_TO_PREVIOUS -> {
                if (currentParagraphIndex > 0) {
                    skipToParagraph(currentParagraphIndex - 1)
                }
            }
            else -> {
                // Convert position to paragraph index for absolute seeks
                val targetIndex =
                    (positionMs / MS_PER_PARAGRAPH).toInt().coerceIn(0, paragraphs.size - 1)
                skipToParagraph(targetIndex)
            }
        }
        return Futures.immediateVoidFuture()
    }

    /**
     * Returns whether TTS is ready to speak.
     */
    fun isTtsReady(): Boolean = ttsReady

    /**
     * Releases all resources.
     */
    fun shutdown() {
        tts?.stop()
        tts?.shutdown()
        tts = null
    }
}
