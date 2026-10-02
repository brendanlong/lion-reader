package com.lionreader.app.narration

import android.app.PendingIntent
import android.content.Intent
import android.os.Handler
import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.FlagSet
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import com.lionreader.app.MainActivity
import com.lionreader.app.graph
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * Puts the [Narrator]'s player in a media session: the notification, lock-screen and headset
 * controls, and the foreground service that keeps narration going in the background.
 */
class NarrationService : MediaSessionService() {
    private var session: MediaSession? = null
    private var scope: CoroutineScope? = null
    private var sessionPlayer: SessionPlayer? = null

    override fun onCreate() {
        super.onCreate()
        val narrator = graph.narrator
        val player = SessionPlayer(narrator)
        session =
            MediaSession.Builder(this, player)
                .setSessionActivity(
                    PendingIntent.getActivity(
                        this,
                        0,
                        Intent(this, MainActivity::class.java),
                        PendingIntent.FLAG_IMMUTABLE,
                    )
                )
                .build()
        sessionPlayer = player
        scope = MainScope().apply { launch { narrator.state.collect { player.skipsChanged() } } }
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

    override fun onDestroy() {
        scope?.cancel()
        scope = null
        sessionPlayer?.detach()
        sessionPlayer = null
        // The player belongs to the narrator, which outlives the service.
        session?.release()
        session = null
        super.onDestroy()
    }
}

/**
 * What the media controls drive: the narrator's player, except that
 * - next and previous (notification, lock screen, headset) move by paragraph, as in the app, not by
 *   the player's items, which are chunks; and they're offered only where there's a paragraph to go
 *   to, so they grey out on the first and last;
 * - "play" on a player that ended (it seeks to the start first: Util.handlePlayButtonAction)
 *   doesn't start the last chunk over when narration is only waiting for the next to be
 *   synthesized.
 *
 * Main thread only, like the player.
 */
@OptIn(UnstableApi::class)
internal class SessionPlayer(private val narrator: Narrator) : ForwardingPlayer(narrator.player) {
    /** The session's: they hear of the player's events through ForwardingPlayer, and ours here. */
    private val listeners = mutableListOf<Player.Listener>()
    private var announced: Player.Commands? = null
    private val main = Handler(Looper.getMainLooper())

    override fun seekToDefaultPosition() {
        if (playbackState == Player.STATE_ENDED && narrator.awaitingSynthesis()) return
        super.seekToDefaultPosition()
    }

    override fun seekToNext() = narrator.skipParagraphs(1)

    override fun seekToNextMediaItem() = narrator.skipParagraphs(1)

    override fun seekToPrevious() = narrator.skipParagraphs(-1)

    override fun seekToPreviousMediaItem() = narrator.skipParagraphs(-1)

    override fun getAvailableCommands(): Player.Commands {
        val previous = narrator.canSkipParagraphs(-1)
        val next = narrator.canSkipParagraphs(1)
        return super.getAvailableCommands()
            .buildUpon()
            .removeAll(
                Player.COMMAND_SEEK_TO_PREVIOUS,
                Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM,
                Player.COMMAND_SEEK_TO_NEXT,
                Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM,
            )
            .addIf(Player.COMMAND_SEEK_TO_PREVIOUS, previous)
            .addIf(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM, previous)
            .addIf(Player.COMMAND_SEEK_TO_NEXT, next)
            .addIf(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM, next)
            .build()
    }

    override fun isCommandAvailable(command: Int): Boolean = availableCommands.contains(command)

    private val playerCommands =
        object : Player.Listener {
            override fun onAvailableCommandsChanged(availableCommands: Player.Commands) {
                // ExoPlayer's, without our skips, reach the session too: correct them after.
                announced = null
                main.post(::skipsChanged)
            }
        }

    init {
        narrator.player.addListener(playerCommands)
    }

    /** Stops following the player, which outlives the session. */
    fun detach() {
        narrator.player.removeListener(playerCommands)
        main.removeCallbacksAndMessages(null)
    }

    override fun addListener(listener: Player.Listener) {
        listeners += listener
        super.addListener(listener)
    }

    override fun removeListener(listener: Player.Listener) {
        listeners -= listener
        super.removeListener(listener)
    }

    /** Tells the session when moving through the article changed which skips there are. */
    fun skipsChanged() {
        val commands = availableCommands
        if (commands == announced) return
        announced = commands
        val events =
            Player.Events(FlagSet.Builder().add(Player.EVENT_AVAILABLE_COMMANDS_CHANGED).build())
        for (listener in listeners.toList()) {
            listener.onAvailableCommandsChanged(commands)
            listener.onEvents(this, events)
        }
    }
}
