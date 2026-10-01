package com.lionreader.app.narration

import android.app.PendingIntent
import android.content.Intent
import androidx.annotation.OptIn
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import com.lionreader.app.MainActivity
import com.lionreader.app.graph

/**
 * Puts the [Narrator]'s player in a media session: the notification, lock-screen and headset
 * controls, and the foreground service that keeps narration going in the background.
 */
class NarrationService : MediaSessionService() {
    private var session: MediaSession? = null

    override fun onCreate() {
        super.onCreate()
        session =
            MediaSession.Builder(this, SessionPlayer(graph.narrator))
                .setSessionActivity(
                    PendingIntent.getActivity(
                        this,
                        0,
                        Intent(this, MainActivity::class.java),
                        PendingIntent.FLAG_IMMUTABLE,
                    )
                )
                .build()
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

    /**
     * What the media controls drive: the narrator's player, except that their "play" on a player
     * that ended (it seeks to the start first: Util.handlePlayButtonAction) doesn't start the last
     * chunk over when narration is only waiting for the next to be synthesized.
     */
    @OptIn(UnstableApi::class)
    private class SessionPlayer(private val narrator: Narrator) :
        ForwardingPlayer(narrator.player) {
        override fun seekToDefaultPosition() {
            if (playbackState == Player.STATE_ENDED && narrator.awaitingSynthesis()) return
            super.seekToDefaultPosition()
        }
    }

    override fun onDestroy() {
        // The player belongs to the narrator, which outlives the service.
        session?.release()
        session = null
        super.onDestroy()
    }
}
