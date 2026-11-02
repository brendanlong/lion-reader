package com.lionreader.app.narration

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import com.lionreader.shared.api.NarrationCues
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Says Settings' preview in [voice], straight to the speaker as it's made; cancelling stops it. Not
 * through the narration player: a preview has no article, notification or media session. It takes
 * audio focus for a moment, so narration (whose player follows focus) pauses meanwhile, and stops
 * if something else takes it. The model makes the audio and a coroutine of its own plays it, so the
 * model's thread never waits on the speaker.
 */
suspend fun previewEnhancedVoice(context: Context, model: EnhancedVoiceModel, voice: String) =
    coroutineScope {
        val attributes =
            AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build()
        val audio = context.getSystemService(AudioManager::class.java)
        val focus =
            AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                .setAudioAttributes(attributes)
                .setOnAudioFocusChangeListener { change ->
                    if (change < 0) cancel("Audio focus went elsewhere")
                }
                .build()
        if (audio.requestAudioFocus(focus) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
            return@coroutineScope
        }
        val track =
            AudioTrack.Builder()
                .setAudioAttributes(attributes)
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
                        .setSampleRate(PhononTts.SAMPLE_RATE)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                        .build()
                )
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build()
        try {
            val pcm = Channel<FloatArray>(Channel.UNLIMITED)
            val playing =
                launch(Dispatchers.IO) {
                    track.play()
                    var frames = 0
                    for (piece in pcm) {
                        track.write(piece, 0, piece.size, AudioTrack.WRITE_BLOCKING)
                        frames += piece.size
                    }
                    // Waits for what's written to play out (stopping first would reset the
                    // position, which then never gets there), up to as long as it lasts and a bit.
                    val deadline =
                        System.nanoTime() +
                            frames * 1_000_000_000L / PhononTts.SAMPLE_RATE +
                            2_000_000_000L
                    while (track.playbackHeadPosition < frames && System.nanoTime() < deadline) {
                        delay(50)
                    }
                    track.stop()
                }
            try {
                model.withModel { tts, removed ->
                    tts.setVoice(voice)
                    tts.speak(NarrationCues.PREVIEW) { piece ->
                        if (!isActive || removed()) return@speak false
                        pcm.trySend(piece)
                        true
                    }
                }
            } finally {
                pcm.close()
            }
            playing.join()
        } finally {
            track.release()
            audio.abandonAudioFocusRequest(focus)
        }
    }
