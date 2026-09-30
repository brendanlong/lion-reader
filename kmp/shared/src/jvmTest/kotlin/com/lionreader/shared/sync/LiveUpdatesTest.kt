package com.lionreader.shared.sync

import io.ktor.utils.io.ByteChannel
import io.ktor.utils.io.ByteReadChannel
import io.ktor.utils.io.writeStringUtf8
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest

private fun event(type: String) = "event: $type\nid: 2026-09-30T00:00:00Z\ndata: {}\n\n"

@OptIn(ExperimentalCoroutinesApi::class)
class LiveUpdatesTest {
    private val server = FakeServer()
    private var pulls = 0

    private fun TestScope.follow(retry: (Int) -> Duration = { 10.seconds }) =
        backgroundScope.launch {
            followLiveUpdates(
                server.api(StandardTestDispatcher(testScheduler)),
                pull = { pulls++ },
                retry = retry,
                clock = testScheduler.timeSource,
            )
        }

    private val eventRequests
        get() = server.requests.count { it.url.encodedPath == "/api/v1/events" }

    @Test
    fun changesPullAndBurstsPullOnce() = runTest {
        val stream = ByteChannel(autoFlush = true)
        server.eventStreams += stream
        follow()
        advanceTimeBy(5.seconds)
        // Connecting pulls, for what changed while not listening.
        assertEquals(1, pulls)

        stream.writeStringUtf8(": heartbeat\n\n" + event("new_entry"))
        advanceTimeBy(5.seconds)
        assertEquals(2, pulls)

        stream.writeStringUtf8(event("entry_state_changed"))
        advanceTimeBy(1.seconds)
        stream.writeStringUtf8(event("new_entry") + event("mark_all_read"))
        advanceTimeBy(5.seconds)
        assertEquals(3, pulls)
    }

    @Test
    fun eventsAboutOtherThingsDoNotPull() = runTest {
        val stream = ByteChannel(autoFlush = true)
        server.eventStreams += stream
        follow()
        advanceTimeBy(5.seconds)

        stream.writeStringUtf8(event("import_progress") + event("announcement_changed"))
        advanceTimeBy(5.seconds)

        assertEquals(1, pulls)
    }

    @Test
    fun reconnectsAfterFailuresAndPullsForWhatItMissed() = runTest {
        server.eventStreams += null
        server.eventStreams += null
        server.eventStreams += ByteReadChannel("")
        follow()

        runCurrent()
        assertEquals(0, pulls)
        // Unavailable: the server asks for 30s between tries.
        advanceTimeBy(65.seconds)
        assertEquals(3, eventRequests)
        assertEquals(1, pulls)
    }

    @Test
    fun aStreamThatKeepsClosingBacksOff() = runTest {
        repeat(20) { server.eventStreams += ByteReadChannel("") }
        follow(retry = { 10.seconds * (it + 1) })

        advanceTimeBy(99.seconds)

        // At 0, 10, 30 and 60s: each opened, but none stayed up long enough to reset the backoff.
        assertEquals(4, eventRequests)
    }
}
