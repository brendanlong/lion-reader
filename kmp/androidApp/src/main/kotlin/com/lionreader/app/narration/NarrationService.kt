package com.lionreader.app.narration

import android.app.PendingIntent
import android.content.Intent
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
            MediaSession.Builder(this, graph.narrator.player)
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

    override fun onDestroy() {
        // The player belongs to the narrator, which outlives the service.
        session?.release()
        session = null
        super.onDestroy()
    }
}
