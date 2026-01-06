package com.lionreader.service

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Binder
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import androidx.media3.session.MediaStyleNotificationHelper
import com.lionreader.data.api.ApiResult
import com.lionreader.data.api.LionReaderApi
import com.lionreader.data.api.models.ParagraphMapEntry
import com.lionreader.ui.narration.HtmlToTextConverter
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

@UnstableApi
@AndroidEntryPoint
class NarrationService : MediaSessionService() {
    @Inject
    lateinit var api: LionReaderApi

    private var mediaSession: MediaSession? = null
    private var ttsPlayer: TtsPlayer? = null

    // Audio focus management - required for Bluetooth media button routing
    private lateinit var audioManager: AudioManager
    private lateinit var audioFocusRequest: AudioFocusRequest
    private var hasAudioFocus = false
    private var wasPlayingBeforeFocusLoss = false

    private val audioFocusChangeListener =
        AudioManager.OnAudioFocusChangeListener { focusChange ->
            when (focusChange) {
                AudioManager.AUDIOFOCUS_GAIN -> {
                    // Regained focus - resume if we were playing before
                    if (wasPlayingBeforeFocusLoss && !isPlaying) {
                        resumePlayback()
                    }
                    wasPlayingBeforeFocusLoss = false
                }
                AudioManager.AUDIOFOCUS_LOSS -> {
                    // Permanent loss - stop playback
                    wasPlayingBeforeFocusLoss = false
                    if (isPlaying) {
                        pausePlayback()
                    }
                }
                AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
                    // Temporary loss (e.g., phone call) - pause and remember state
                    if (isPlaying) {
                        wasPlayingBeforeFocusLoss = true
                        pausePlayback()
                    }
                }
                AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
                    // Could duck, but for TTS it's better to pause
                    if (isPlaying) {
                        wasPlayingBeforeFocusLoss = true
                        pausePlayback()
                    }
                }
            }
        }

    // Coroutine scope for async operations
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    // Current playback state
    private var currentEntryId: String? = null
    private var currentEntryTitle: String? = null
    private var currentFeedTitle: String? = null
    private var paragraphs: List<String> = emptyList()
    private var paragraphMap: List<ParagraphMapEntry> = emptyList()
    private var currentParagraphIndex = 0
    private var isPlaying = false
    private var currentSource: NarrationSource = NarrationSource.LOCAL

    // Binder for UI communication
    private val binder = NarrationBinder()
    private val _playbackState = MutableStateFlow<NarrationState>(NarrationState.Idle)
    val playbackState: StateFlow<NarrationState> = _playbackState.asStateFlow()

    inner class NarrationBinder : Binder() {
        fun getService(): NarrationService = this@NarrationService
    }

    override fun onBind(intent: Intent?): IBinder? {
        // Allow both MediaSessionService binding and our custom binder
        val superBinder = super.onBind(intent)
        return if (intent?.action == SERVICE_INTERFACE) {
            superBinder
        } else {
            binder
        }
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = mediaSession

    override fun onCreate() {
        super.onCreate()

        // Initialize audio focus management
        audioManager = getSystemService(AudioManager::class.java)
        val audioAttributes =
            AudioAttributes
                .Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build()
        audioFocusRequest =
            AudioFocusRequest
                .Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(audioAttributes)
                .setOnAudioFocusChangeListener(audioFocusChangeListener)
                .setWillPauseWhenDucked(true)
                .build()

        // Create notification channel
        createNotificationChannel()

        // Initialize TTS player
        ttsPlayer =
            TtsPlayer(
                context = this,
                looper = Looper.getMainLooper(),
                onParagraphCompleted = {
                    // Advance to next paragraph when current one finishes
                    serviceScope.launch(Dispatchers.Main) {
                        advanceToNextParagraph()
                    }
                },
                onParagraphChanged = { newIndex ->
                    // Update service state when MediaSession triggers paragraph change
                    serviceScope.launch(Dispatchers.Main) {
                        handleParagraphChangedFromPlayer(newIndex)
                    }
                },
                onError = { message ->
                    serviceScope.launch(Dispatchers.Main) {
                        _playbackState.value = NarrationState.Error(message)
                    }
                },
            )

        // Create media session with Media3
        mediaSession =
            MediaSession
                .Builder(this, ttsPlayer!!)
                .setCallback(mediaSessionCallback)
                .build()
    }

    private val mediaSessionCallback =
        object : MediaSession.Callback {
            override fun onConnect(
                session: MediaSession,
                controller: MediaSession.ControllerInfo,
            ): MediaSession.ConnectionResult {
                // Accept all connections
                return MediaSession.ConnectionResult
                    .AcceptedResultBuilder(session)
                    .setAvailablePlayerCommands(
                        MediaSession.ConnectionResult.DEFAULT_PLAYER_COMMANDS,
                    ).setAvailableSessionCommands(
                        MediaSession.ConnectionResult.DEFAULT_SESSION_COMMANDS,
                    ).build()
            }
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

        // Set loading state
        _playbackState.value = NarrationState.Loading

        // Start foreground service with loading notification
        startForeground(NOTIFICATION_ID, createNotification())

        // Try to get LLM-cleaned text from server, fall back to local conversion
        serviceScope.launch {
            val result = fetchNarrationText(entryId, content)
            startPlaybackWithText(result.text, result.source, result.paragraphMap)
        }
    }

    /**
     * Result of fetching narration text.
     */
    private data class NarrationFetchResult(
        val text: String,
        val source: NarrationSource,
        val paragraphMap: List<ParagraphMapEntry>,
    )

    /**
     * Fetches narration text from the server with LLM cleanup.
     * Falls back to local HTML-to-text conversion if server is unavailable.
     *
     * @param entryId The entry ID to fetch narration for
     * @param htmlContent The HTML content as fallback
     * @return NarrationFetchResult with text, source, and paragraph mapping
     */
    private suspend fun fetchNarrationText(
        entryId: String,
        htmlContent: String,
    ): NarrationFetchResult =
        try {
            when (val result = api.generateNarration(entryId)) {
                is ApiResult.Success -> {
                    val response = result.data
                    val source =
                        if (response.source == "llm") {
                            NarrationSource.LLM
                        } else {
                            NarrationSource.LOCAL
                        }
                    NarrationFetchResult(response.narration, source, response.paragraphMap)
                }
                is ApiResult.Error,
                is ApiResult.NetworkError,
                is ApiResult.RateLimited,
                ApiResult.Unauthorized,
                -> {
                    // API error, fall back to local conversion with mapping
                    val conversionResult = HtmlToTextConverter.convertWithMapping(htmlContent)
                    NarrationFetchResult(
                        conversionResult.paragraphs.joinToString("\n\n"),
                        NarrationSource.LOCAL,
                        conversionResult.paragraphMap,
                    )
                }
            }
        } catch (e: Exception) {
            // Network or other error, fall back to local conversion with mapping
            val conversionResult = HtmlToTextConverter.convertWithMapping(htmlContent)
            NarrationFetchResult(
                conversionResult.paragraphs.joinToString("\n\n"),
                NarrationSource.LOCAL,
                conversionResult.paragraphMap,
            )
        }

    /**
     * Translates a narration paragraph index to the corresponding HTML element index.
     */
    private fun getElementIndex(narrationIndex: Int): Int = paragraphMap.find { it.n == narrationIndex }?.o ?: narrationIndex

    /**
     * Starts playback with the given narration text.
     */
    private fun startPlaybackWithText(
        narrationText: String,
        source: NarrationSource,
        mapping: List<ParagraphMapEntry>,
    ) {
        // Split into paragraphs by double newlines
        paragraphs =
            narrationText
                .split(Regex("\n\n+"))
                .map { it.trim() }
                .filter { it.isNotEmpty() }

        // Store the paragraph map for highlighting
        paragraphMap = mapping

        if (paragraphs.isEmpty()) {
            _playbackState.value = NarrationState.Error("No content to narrate")
            stopForeground(STOP_FOREGROUND_REMOVE)
            return
        }

        currentParagraphIndex = 0
        currentSource = source

        // Set up the TTS player with paragraphs
        ttsPlayer?.setParagraphs(
            paragraphs = paragraphs,
            title = currentEntryTitle ?: "Untitled",
            feedTitle = currentFeedTitle ?: "",
        )

        // Update notification and start playback
        updateNotification()
        playCurrentParagraph()
    }

    private fun playCurrentParagraph() {
        val player = ttsPlayer ?: return

        if (!player.isTtsReady()) {
            _playbackState.value = NarrationState.Error("TTS not ready")
            return
        }

        if (currentParagraphIndex >= paragraphs.size) {
            // Finished all paragraphs
            stopPlayback()
            return
        }

        // Request audio focus before playing - this is critical for Bluetooth media button routing
        if (!hasAudioFocus) {
            val result = audioManager.requestAudioFocus(audioFocusRequest)
            if (result != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
                _playbackState.value = NarrationState.Error("Could not acquire audio focus")
                return
            }
            hasAudioFocus = true
        }

        isPlaying = true

        _playbackState.value =
            NarrationState.Playing(
                entryId = currentEntryId ?: "",
                currentParagraph = currentParagraphIndex,
                totalParagraphs = paragraphs.size,
                entryTitle = currentEntryTitle ?: "Untitled",
                source = currentSource,
                highlightedElementIndex = getElementIndex(currentParagraphIndex),
            )

        // Start playback via the player
        player.play()
        updateNotification()
    }

    private fun advanceToNextParagraph() {
        if (currentParagraphIndex < paragraphs.size - 1) {
            currentParagraphIndex++
            // Skip to the new paragraph index, notifyChange=false since service initiated
            ttsPlayer?.skipToParagraph(currentParagraphIndex, notifyChange = false)

            _playbackState.value =
                NarrationState.Playing(
                    entryId = currentEntryId ?: "",
                    currentParagraph = currentParagraphIndex,
                    totalParagraphs = paragraphs.size,
                    entryTitle = currentEntryTitle ?: "Untitled",
                    source = currentSource,
                    highlightedElementIndex = getElementIndex(currentParagraphIndex),
                )
            updateNotification()
        } else {
            // Finished all paragraphs
            stopPlayback()
        }
    }

    /**
     * Called when the TtsPlayer changes paragraph due to MediaSession commands
     * (e.g., skip next/previous from notification or Bluetooth controls).
     */
    private fun handleParagraphChangedFromPlayer(newIndex: Int) {
        if (newIndex == currentParagraphIndex) return

        currentParagraphIndex = newIndex
        if (isPlaying) {
            _playbackState.value =
                NarrationState.Playing(
                    entryId = currentEntryId ?: "",
                    currentParagraph = currentParagraphIndex,
                    totalParagraphs = paragraphs.size,
                    entryTitle = currentEntryTitle ?: "Untitled",
                    source = currentSource,
                    highlightedElementIndex = getElementIndex(currentParagraphIndex),
                )
        } else {
            _playbackState.value =
                NarrationState.Paused(
                    entryId = currentEntryId ?: "",
                    currentParagraph = currentParagraphIndex,
                    totalParagraphs = paragraphs.size,
                    entryTitle = currentEntryTitle ?: "Untitled",
                    source = currentSource,
                    highlightedElementIndex = getElementIndex(currentParagraphIndex),
                )
        }
        updateNotification()
    }

    fun pausePlayback() {
        ttsPlayer?.pause()
        isPlaying = false

        _playbackState.value =
            NarrationState.Paused(
                entryId = currentEntryId ?: "",
                currentParagraph = currentParagraphIndex,
                totalParagraphs = paragraphs.size,
                entryTitle = currentEntryTitle ?: "Untitled",
                source = currentSource,
                highlightedElementIndex = getElementIndex(currentParagraphIndex),
            )

        updateNotification()
    }

    fun resumePlayback() {
        playCurrentParagraph()
    }

    fun togglePlayback() {
        if (isPlaying) {
            pausePlayback()
        } else {
            resumePlayback()
        }
    }

    fun stopPlayback() {
        ttsPlayer?.stop()
        isPlaying = false
        currentEntryId = null
        currentEntryTitle = null
        currentFeedTitle = null
        paragraphs = emptyList()
        paragraphMap = emptyList()
        currentSource = NarrationSource.LOCAL

        // Abandon audio focus when stopping playback
        if (hasAudioFocus) {
            audioManager.abandonAudioFocusRequest(audioFocusRequest)
            hasAudioFocus = false
        }
        wasPlayingBeforeFocusLoss = false

        _playbackState.value = NarrationState.Idle

        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    fun skipToNextParagraph() {
        if (currentParagraphIndex < paragraphs.size - 1) {
            currentParagraphIndex++
            ttsPlayer?.skipToParagraph(currentParagraphIndex, notifyChange = false)
            if (isPlaying) {
                _playbackState.value =
                    NarrationState.Playing(
                        entryId = currentEntryId ?: "",
                        currentParagraph = currentParagraphIndex,
                        totalParagraphs = paragraphs.size,
                        entryTitle = currentEntryTitle ?: "Untitled",
                        source = currentSource,
                        highlightedElementIndex = getElementIndex(currentParagraphIndex),
                    )
            } else {
                _playbackState.value =
                    NarrationState.Paused(
                        entryId = currentEntryId ?: "",
                        currentParagraph = currentParagraphIndex,
                        totalParagraphs = paragraphs.size,
                        entryTitle = currentEntryTitle ?: "Untitled",
                        source = currentSource,
                        highlightedElementIndex = getElementIndex(currentParagraphIndex),
                    )
            }
            updateNotification()
        }
    }

    fun skipToPreviousParagraph() {
        if (currentParagraphIndex > 0) {
            currentParagraphIndex--
            ttsPlayer?.skipToParagraph(currentParagraphIndex, notifyChange = false)
            if (isPlaying) {
                _playbackState.value =
                    NarrationState.Playing(
                        entryId = currentEntryId ?: "",
                        currentParagraph = currentParagraphIndex,
                        totalParagraphs = paragraphs.size,
                        entryTitle = currentEntryTitle ?: "Untitled",
                        source = currentSource,
                        highlightedElementIndex = getElementIndex(currentParagraphIndex),
                    )
            } else {
                _playbackState.value =
                    NarrationState.Paused(
                        entryId = currentEntryId ?: "",
                        currentParagraph = currentParagraphIndex,
                        totalParagraphs = paragraphs.size,
                        entryTitle = currentEntryTitle ?: "Untitled",
                        source = currentSource,
                        highlightedElementIndex = getElementIndex(currentParagraphIndex),
                    )
            }
            updateNotification()
        }
    }

    private fun createNotification(): android.app.Notification {
        val channelId = NOTIFICATION_CHANNEL_ID

        return NotificationCompat
            .Builder(this, channelId)
            .setContentTitle(currentEntryTitle ?: "Lion Reader")
            .setContentText("${currentParagraphIndex + 1} of ${paragraphs.size}")
            .setSubText(currentFeedTitle)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setOngoing(true)
            .setStyle(
                MediaStyleNotificationHelper
                    .MediaStyle(mediaSession!!)
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

    private fun createNotificationChannel() {
        val channel =
            NotificationChannel(
                NOTIFICATION_CHANNEL_ID,
                "Narration",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "Audio narration playback"
                setShowBadge(false)
            }

        val notificationManager = getSystemService(NotificationManager::class.java)
        notificationManager.createNotificationChannel(channel)
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
            action.hashCode(),
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
        return super.onStartCommand(intent, flags, startId)
    }

    override fun onDestroy() {
        // Abandon audio focus on destroy
        if (hasAudioFocus) {
            audioManager.abandonAudioFocusRequest(audioFocusRequest)
            hasAudioFocus = false
        }
        serviceScope.cancel()
        mediaSession?.release()
        mediaSession = null
        ttsPlayer?.shutdown()
        ttsPlayer = null
        super.onDestroy()
    }

    companion object {
        const val NOTIFICATION_ID = 1
        const val NOTIFICATION_CHANNEL_ID = "narration"
        const val ACTION_PLAY = "com.lionreader.PLAY"
        const val ACTION_PAUSE = "com.lionreader.PAUSE"
        const val ACTION_NEXT = "com.lionreader.NEXT"
        const val ACTION_PREVIOUS = "com.lionreader.PREVIOUS"
        const val ACTION_STOP = "com.lionreader.STOP"
    }
}
