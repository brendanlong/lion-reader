package com.lionreader.shared.sync

import com.lionreader.shared.api.ApiException
import com.lionreader.shared.api.LionReaderApi
import kotlin.time.Duration
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** The server's events that mean the account's data changed, so there's something to pull. */
private val DATA_EVENTS =
    setOf(
        "new_entry",
        "entry_updated",
        "entry_state_changed",
        "mark_all_read",
        "subscription_created",
        "subscription_updated",
        "subscription_deleted",
        "tag_created",
        "tag_updated",
        "tag_deleted",
    )

/**
 * Pulls whenever the server says the account's data changed, until cancelled (the app runs it while
 * it's on screen). The events only say *that* something changed; [pull] fetches what, through the
 * same sync as everything else. A burst of events (a feed refresh brings many) makes one pull,
 * [settle] after the first. It pulls on connecting too, for what changed while it wasn't listening
 * (the app in the background, a dropped connection), and reconnects with backoff. Gives up when
 * signed out.
 */
suspend fun followLiveUpdates(
    api: LionReaderApi,
    pull: suspend () -> Unit,
    settle: Duration = 2.seconds,
    retry: (failures: Int) -> Duration = { minOf(5.seconds * (1 shl minOf(it, 6)), 5.minutes) },
) = coroutineScope {
    val pending = Channel<Unit>(Channel.CONFLATED)
    launch {
        for (signal in pending) {
            delay(settle)
            // This pull covers what arrived while settling.
            pending.tryReceive()
            try {
                pull()
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // The periodic sync and the next event try again.
            }
        }
    }
    var failures = 0
    while (true) {
        try {
            api.events(
                onOpen = {
                    pending.trySend(Unit)
                    failures = 0
                },
                onEvent = { if (it in DATA_EVENTS) pending.trySend(Unit) },
            )
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiException) {
            if (e.status == 0) break
        } catch (_: Exception) {}
        delay(retry(failures++))
    }
    pending.close()
}
