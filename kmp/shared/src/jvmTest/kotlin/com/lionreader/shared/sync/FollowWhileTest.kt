package com.lionreader.shared.sync

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest

class FollowWhileTest {
    private val live = MutableStateFlow(false)
    private val calls = mutableListOf<String>()

    private suspend fun follow() {
        calls += "follow"
        try {
            awaitCancellation()
        } catch (e: CancellationException) {
            calls += "stop"
            throw e
        }
    }

    @Test
    fun offAtFirstPullsOnceThenFollowsWhileOn() = runTest {
        backgroundScope.launch { followWhile(live, ::follow, pull = { calls += "pull" }) }
        runCurrent()
        assertEquals(listOf("pull"), calls)

        live.value = true
        runCurrent()
        live.value = false
        runCurrent()

        // Following just caught up, so turning off doesn't pull again.
        assertEquals(listOf("pull", "follow", "stop"), calls)
    }

    @Test
    fun onAtFirstFollowsWithoutAnExtraPull() = runTest {
        live.value = true
        backgroundScope.launch { followWhile(live, ::follow, pull = { calls += "pull" }) }
        runCurrent()

        assertEquals(listOf("follow"), calls)
    }

    @Test
    fun aFailedCatchUpStillFollowsLater() = runTest {
        backgroundScope.launch { followWhile(live, ::follow, pull = { error("offline") }) }
        runCurrent()
        live.value = true
        runCurrent()

        assertEquals(listOf("follow"), calls)
    }
}
