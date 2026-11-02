package com.lionreader.app.narration

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import com.lionreader.shared.api.NarrationCues
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.job

/**
 * Says Settings' preview in [voice], straight to the speaker as it's made; cancelling stops it. Not
 * through the narration player: a preview has no article, notification or media session.
 */
suspend fun previewEnhancedVoice(model: EnhancedVoiceModel, voice: String) {
    val caller = currentCoroutineContext().job
    val track =
        AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build()
            )
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
        track.play()
        var frames = 0
        model.withModel { tts, removed ->
            tts.setVoice(voice)
            tts.speak(NarrationCues.PREVIEW) { pcm ->
                if (!caller.isActive || removed()) return@speak false
                track.write(pcm, 0, pcm.size, AudioTrack.WRITE_BLOCKING)
                frames += pcm.size
                true
            }
        }
        // Waits for what's written to play out (stopping first would reset the position, which
        // then never gets there), up to as long as it lasts and a bit.
        val deadline =
            System.nanoTime() + (frames * 1_000_000_000L / PhononTts.SAMPLE_RATE) + 2_000_000_000L
        while (track.playbackHeadPosition < frames && System.nanoTime() < deadline) delay(50)
        track.stop()
    } finally {
        track.release()
    }
}
