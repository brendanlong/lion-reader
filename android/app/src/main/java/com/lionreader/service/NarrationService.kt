package com.lionreader.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Binder
import android.os.IBinder
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import androidx.core.app.NotificationCompat
import com.lionreader.R
import com.lionreader.ui.narration.HtmlToTextConverter
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.Locale

@AndroidEntryPoint
class NarrationService : Service() {
    private var mediaSession: MediaSessionCompat? = null
    private var tts: TextToSpeech? = null
    private var ttsReady = false

    // Current playback state
    private var currentEntryId: String? = null
    private var currentEntryTitle: String? = null
    private var currentFeedTitle: String? = null
    private var paragraphs: List<String> = emptyList()
    private var currentParagraphIndex = 0
    private var isPlaying = false

    // Binder for UI communication
    private val binder = NarrationBinder()
    private val _playbackState = MutableStateFlow<NarrationState>(NarrationState.Idle)
    val playbackState: StateFlow<NarrationState> = _playbackState.asStateFlow()

    inner class NarrationBinder : Binder() {
        fun getService(): NarrationService = this@NarrationService
    }

    override fun onBind(intent: Intent): IBinder = binder

    override fun onCreate() {
        super.onCreate()

        // Initialize TTS
        tts =
            TextToSpeech(this) { status ->
                if (status == TextToSpeech.SUCCESS) {
                    tts?.language = Locale.US
                    ttsReady = true
                }
            }

        // Create media session
        mediaSession =
            MediaSessionCompat(this, "NarrationService").apply {
                setCallback(mediaSessionCallback)
                isActive = true
            }
    }

    private val mediaSessionCallback =
        object : MediaSessionCompat.Callback() {
            override fun onPlay() = resumePlayback()

            override fun onPause() = pausePlayback()

            override fun onStop() = stopPlayback()

            override fun onSkipToNext() = skipToNextParagraph()

            override fun onSkipToPrevious() = skipToPreviousParagraph()
        }

    fun startNarration(
        entryId: String,
        title: String,
        feedTitle: String,
        content: String,
    ) {
        currentEntryId = entryId
        currentEntryTitle = title
        currentFeedTitle = feedTitle

        // Convert HTML to paragraphs
        paragraphs = HtmlToTextConverter.convert(content)

        if (paragraphs.isEmpty()) {
            _playbackState.value = NarrationState.Error("No content to narrate")
            return
        }

        currentParagraphIndex = 0

        // Start foreground service
        startForeground(NOTIFICATION_ID, createNotification())

        playCurrentParagraph()
    }

    private fun playCurrentParagraph() {
        if (!ttsReady) {
            _playbackState.value = NarrationState.Error("TTS not ready")
            return
        }

        if (currentParagraphIndex >= paragraphs.size) {
            // Finished all paragraphs
            stopPlayback()
            return
        }

        val paragraph = paragraphs[currentParagraphIndex]
        isPlaying = true

        _playbackState.value =
            NarrationState.Playing(
                entryId = currentEntryId ?: "",
                currentParagraph = currentParagraphIndex,
                totalParagraphs = paragraphs.size,
                entryTitle = currentEntryTitle ?: "Untitled",
            )

        tts?.setOnUtteranceProgressListener(
            object : UtteranceProgressListener() {
                override fun onDone(utteranceId: String?) {
                    if (isPlaying) {
                        currentParagraphIndex++
                        playCurrentParagraph()
                    }
                }

                override fun onError(utteranceId: String?) {
                    _playbackState.value = NarrationState.Error("TTS error")
                }

                override fun onStart(utteranceId: String?) {
                    updateNotification()
                }
            },
        )

        tts?.speak(
            paragraph,
            TextToSpeech.QUEUE_FLUSH,
            null,
            "paragraph_$currentParagraphIndex",
        )

        updatePlaybackState(PlaybackStateCompat.STATE_PLAYING)
    }

    fun pausePlayback() {
        tts?.stop()
        isPlaying = false

        _playbackState.value =
            NarrationState.Paused(
                entryId = currentEntryId ?: "",
                currentParagraph = currentParagraphIndex,
                totalParagraphs = paragraphs.size,
                entryTitle = currentEntryTitle ?: "Untitled",
            )

        updatePlaybackState(PlaybackStateCompat.STATE_PAUSED)
        updateNotification()
    }

    fun resumePlayback() {
        playCurrentParagraph()
    }

    fun stopPlayback() {
        tts?.stop()
        isPlaying = false
        currentEntryId = null
        currentEntryTitle = null
        currentFeedTitle = null
        paragraphs = emptyList()

        _playbackState.value = NarrationState.Idle

        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    fun skipToNextParagraph() {
        if (currentParagraphIndex < paragraphs.size - 1) {
            tts?.stop()
            currentParagraphIndex++
            if (isPlaying) {
                playCurrentParagraph()
            } else {
                _playbackState.value =
                    NarrationState.Paused(
                        entryId = currentEntryId ?: "",
                        currentParagraph = currentParagraphIndex,
                        totalParagraphs = paragraphs.size,
                        entryTitle = currentEntryTitle ?: "Untitled",
                    )
            }
        }
    }

    fun skipToPreviousParagraph() {
        if (currentParagraphIndex > 0) {
            tts?.stop()
            currentParagraphIndex--
            if (isPlaying) {
                playCurrentParagraph()
            } else {
                _playbackState.value =
                    NarrationState.Paused(
                        entryId = currentEntryId ?: "",
                        currentParagraph = currentParagraphIndex,
                        totalParagraphs = paragraphs.size,
                        entryTitle = currentEntryTitle ?: "Untitled",
                    )
            }
        }
    }

    private fun createNotification(): Notification {
        val channelId = createNotificationChannel()

        return NotificationCompat
            .Builder(this, channelId)
            .setContentTitle(currentEntryTitle ?: "Lion Reader")
            .setContentText("${currentParagraphIndex + 1} of ${paragraphs.size}")
            .setSubText(currentFeedTitle)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setOngoing(true)
            .setStyle(
                androidx.media.app.NotificationCompat
                    .MediaStyle()
                    .setMediaSession(mediaSession?.sessionToken)
                    .setShowActionsInCompactView(0, 1, 2),
            ).addAction(
                android.R.drawable.ic_media_previous,
                "Previous",
                createPendingIntent(ACTION_PREVIOUS),
            ).addAction(
                if (isPlaying) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play,
                if (isPlaying) "Pause" else "Play",
                createPendingIntent(if (isPlaying) ACTION_PAUSE else ACTION_PLAY),
            ).addAction(
                android.R.drawable.ic_media_next,
                "Next",
                createPendingIntent(ACTION_NEXT),
            ).build()
    }

    private fun createNotificationChannel(): String {
        val channelId = "narration"
        val channel =
            NotificationChannel(
                channelId,
                "Narration",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "Audio narration playback"
                setShowBadge(false)
            }

        val notificationManager = getSystemService(NotificationManager::class.java)
        notificationManager.createNotificationChannel(channel)

        return channelId
    }

    private fun updatePlaybackState(state: Int) {
        val playbackState =
            PlaybackStateCompat
                .Builder()
                .setActions(
                    PlaybackStateCompat.ACTION_PLAY or
                        PlaybackStateCompat.ACTION_PAUSE or
                        PlaybackStateCompat.ACTION_SKIP_TO_NEXT or
                        PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or
                        PlaybackStateCompat.ACTION_STOP,
                ).setState(state, currentParagraphIndex.toLong(), 1f)
                .build()

        mediaSession?.setPlaybackState(playbackState)
    }

    private fun updateNotification() {
        val notificationManager = getSystemService(NotificationManager::class.java)
        notificationManager.notify(NOTIFICATION_ID, createNotification())
    }

    private fun createPendingIntent(action: String): PendingIntent {
        val intent =
            Intent(this, NarrationService::class.java).apply {
                this.action = action
            }
        return PendingIntent.getService(
            this,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    override fun onStartCommand(
        intent: Intent?,
        flags: Int,
        startId: Int,
    ): Int {
        when (intent?.action) {
            ACTION_PLAY -> resumePlayback()
            ACTION_PAUSE -> pausePlayback()
            ACTION_NEXT -> skipToNextParagraph()
            ACTION_PREVIOUS -> skipToPreviousParagraph()
            ACTION_STOP -> stopPlayback()
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        mediaSession?.release()
        tts?.shutdown()
        super.onDestroy()
    }

    companion object {
        const val NOTIFICATION_ID = 1
        const val ACTION_PLAY = "com.lionreader.PLAY"
        const val ACTION_PAUSE = "com.lionreader.PAUSE"
        const val ACTION_NEXT = "com.lionreader.NEXT"
        const val ACTION_PREVIOUS = "com.lionreader.PREVIOUS"
        const val ACTION_STOP = "com.lionreader.STOP"
    }
}
