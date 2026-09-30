package com.lionreader.shared.sync

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest

private fun event(type: String) = "event: $type\nid: 2026-09-30T00:00:00Z\ndata: {}\n\n"

@OptIn(ExperimentalCoroutinesApi::class)
class LiveUpdatesTest {
    private val server = FakeServer()
    private var pulls = 0

    private fun kotlinx.coroutines.test.TestScope.follow() = backgroundScope.launch {
        followLiveUpdates(
            server.api(StandardTestDispatcher(testScheduler)),
            pull = { pulls++ },
            retry = { 10.seconds },
        )
    }

    @Test
    fun aBurstOfChangesIsOnePullAndOtherEventsNone() = runTest {
        server.eventStreams +=
            ": heartbeat\n\n" +
                event("new_entry") +
                event("new_entry") +
                event("entry_state_changed") +
                event("import_progress")
        server.eventStreams += null
        follow()

        runCurrent()
        advanceTimeBy(3.seconds)
        // Connecting pulls, and so do the events; they all arrived together.
        assertEquals(1, pulls)
    }

    @Test
    fun eventsOnlyAboutOtherThingsDoNotPull() = runTest {
        server.eventStreams += ""
        follow()
        runCurrent()
        advanceTimeBy(3.seconds)
        assertEquals(1, pulls)

        server.eventStreams.clear()
        server.eventStreams += event("import_progress") + event("announcement_changed")
        advanceTimeBy(15.seconds)
        // Reconnecting pulled once; the events themselves nothing.
        assertEquals(2, pulls)
    }

    @Test
    fun reconnectsAfterFailuresAndPullsForWhatItMissed() = runTest {
        server.eventStreams += null
        server.eventStreams += null
        server.eventStreams += event("new_entry")
        follow()

        runCurrent()
        assertEquals(0, pulls)
        advanceTimeBy(25.seconds)
        assertEquals(1, pulls)
        assertEquals(3, server.requests.count { it.url.encodedPath == "/api/v1/events" })
    }
}
