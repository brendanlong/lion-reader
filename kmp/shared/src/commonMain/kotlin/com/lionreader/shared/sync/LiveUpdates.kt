package com.lionreader.shared.sync

import com.lionreader.shared.api.ApiException
import com.lionreader.shared.api.ApiFailure
import com.lionreader.shared.api.LionReaderApi
import com.lionreader.shared.api.failure
import kotlin.time.Duration
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds
import kotlin.time.TimeMark
import kotlin.time.TimeSource
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
 * (the app in the background, a dropped connection), and reconnects with backoff: a stream only
 * counts as working once it's stayed up for [stable], so one that keeps closing right away (a
 * proxy, the server's Redis trouble) can't make it reconnect, and pull, every few seconds. Gives up
 * when signed out.
 */
suspend fun followLiveUpdates(
    api: LionReaderApi,
    pull: suspend () -> Unit,
    settle: Duration = 2.seconds,
    retry: (failures: Int) -> Duration = { minOf(5.seconds * (1 shl minOf(it, 6)), 5.minutes) },
    stable: Duration = 1.minutes,
    clock: TimeSource = TimeSource.Monotonic,
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
        var opened: TimeMark? = null
        var wait = Duration.ZERO
        try {
            api.events(
                onOpen = {
                    opened = clock.markNow()
                    pending.trySend(Unit)
                },
                onEvent = { if (it in DATA_EVENTS) pending.trySend(Unit) },
            )
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiException) {
            when (e.failure()) {
                ApiFailure.SignedOut -> break
                // The server's Retry-After when its Redis is down.
                is ApiFailure.Busy -> wait = 30.seconds
                else -> {}
            }
        } catch (_: Exception) {}
        if ((opened?.elapsedNow() ?: Duration.ZERO) >= stable) failures = 0
        delay(maxOf(wait, retry(failures++)))
    }
    pending.close()
}
